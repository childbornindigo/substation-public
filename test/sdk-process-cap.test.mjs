import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SdkProcessCap, governorAllowsClaude } from '../src/sdk-process-cap.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, limit = 3, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-cap-')); const statePath = join(dir, 'state.json');
  const state = (pressure_level = 'normal', sampled_at_epoch = Date.now() / 1000) => writeFileSync(statePath, JSON.stringify({ schema_version: 1, sampled_at_epoch, kernel_pressure_level: pressure_level === 'normal' ? 1 : 2, pressure_level, blocked: pressure_level !== 'normal', admission: { claude: pressure_level === 'normal' } }));
  state(); const options = { root: join(dir, 'slots'), statePath, limit, pollMs: 5, queueTimeoutMs: 10000, ...extra };
  const children = new Set(); let peak = 0; let starts = 0;
  const query = ({ options }) => {
    const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),80));setTimeout(()=>process.exit(0),200);"], env: process.env });
    children.add(child); starts++; peak = Math.max(peak, children.size);
    child.once('close', () => children.delete(child));
    return { close() { child.stdin.end(); }, async *[Symbol.asyncIterator]() { yield 'started'; await once(child, 'close'); } };
  };
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await Promise.all([...children].map(c => once(c, 'close'))); rmSync(dir, { recursive: true, force: true }); });
  return { options, state, query, children, get peak() { return peak; }, get starts() { return starts; } };
}

test('40 real inexpensive child requests across two cap instances share three slots', async t => {
  const f = fixture(t); const caps = [new SdkProcessCap(f.options), new SdkProcessCap(f.options)];
  await Promise.all(Array.from({ length: 40 }, async (_, i) => { const q = await caps[i % 2].query(f.query, { options: {} }); for await (const _ of q) {} }));
  assert.equal(f.starts, 40); assert.equal(f.peak, 3); assert.equal(f.children.size, 0);
  assert.equal(readdirSync(f.options.root).length, 0);
  console.log(JSON.stringify({ proof: 'real-child-burst', requests: 40, instances: 2, cap: 3, peakLiveChildren: f.peak, realProviderCalls: 0 }));
});

test('two independent Node HTTP proxies share a global three-child ceiling', async t => {
  const f = fixture(t); const workers = []; let peak = 0; let sampleCount = 0;
  t.after(async () => { for (const worker of workers) if (worker.exitCode === null) { const ended = once(worker, 'exit'); worker.send('close'); await ended; } });
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const worker = fork(new URL('./fixtures/sdk-cap-worker.mjs', import.meta.url), [JSON.stringify({ ...f.options, durationMs: 100 })], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    workers.push(worker); const [ready] = await once(worker, 'message'); ports.push(ready.port);
  }
  const timer = setInterval(() => {
    let live = 0;
    for (const slot of readdirSync(f.options.root)) {
      try { const dir = join(f.options.root, slot); const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]))); if (record.child) { process.kill(record.child, 0); live++; } } catch {}
    }
    sampleCount++; peak = Math.max(peak, live);
  }, 5);
  try {
    await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      const response = await fetch(`http://127.0.0.1:${ports[i % 2]}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'offline-fixture', messages: [] }) });
      assert.equal(response.status, 200); await response.json();
    }));
  } finally { clearInterval(timer); }
  const stats = [];
  for (const worker of workers) { const reply = once(worker, 'message'); worker.send('stats'); stats.push((await reply)[0]); }
  assert.equal(stats.reduce((n, s) => n + s.started, 0), 40); assert.equal(peak, 3);
  assert.ok(sampleCount > 10); assert.equal(readdirSync(f.options.root).length, 0);
  console.log(JSON.stringify({ proof: 'cross-node-http-burst', requests: 40, proxyProcesses: 2, cap: 3, observedLiveChildPidsPeak: peak, samples: sampleCount, realProviderCalls: 0 }));
});

test('cancel queued request; early iterator return retains slot until real child closes', async t => {
  const f = fixture(t, 1); const cap = new SdkProcessCap(f.options); const q = await cap.query(f.query, { options: {} });
  const ac = new AbortController(); const pending = cap.query(f.query, { options: { abortController: ac } }); ac.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  for await (const _ of q) break;
  assert.equal(readdirSync(f.options.root).length, 1, 'HTTP/iterator completion must not free the live child slot');
  const next = await cap.query(f.query, { options: {} }); for await (const _ of next) {}
  assert.equal(f.peak, 1); assert.equal(f.starts, 2); assert.equal(cap.queue.length, 0);
});

test('warning, stale, missing, malformed and unknown pressure cannot spawn; normal drains queue', async t => {
  const f = fixture(t, 1); const cap = new SdkProcessCap(f.options);
  f.state('warning'); const p = cap.query(f.query, { options: {} }); await delay(60); assert.equal(f.starts, 0);
  f.state('normal', Date.now() / 1000 - 31); await delay(30); assert.equal(f.starts, 0);
  rmSync(f.options.statePath); await delay(30); assert.equal(f.starts, 0);
  writeFileSync(f.options.statePath, '{broken'); assert.equal(governorAllowsClaude(f.options.statePath), false);
  f.state('unknown'); await delay(30); assert.equal(f.starts, 0);
  f.state(); const q = await p; for await (const _ of q) {} assert.equal(f.starts, 1);
});

test('queue overflow and timeout reject without spawning; failed spawn returns its slot', async t => {
  const f = fixture(t, 1, { maxQueue: 1, queueTimeoutMs: 50 }); const cap = new SdkProcessCap(f.options);
  f.state('warning'); const p = cap.query(f.query, { options: {} });
  await assert.rejects(cap.query(f.query, { options: {} }), /queue full/);
  await assert.rejects(p, /timed out/); assert.equal(f.starts, 0);
  f.state(); await assert.rejects(cap.query(() => { throw new Error('fixture query failed'); }, { options: {} }), /fixture query failed/);
  assert.equal(readdirSync(f.options.root).length, 0);
});

test('dead owner with unknown child PID stays held; positively dead recorded child can be reclaimed', async t => {
  const f = fixture(t, 1, { queueTimeoutMs: 50 }); const cap = new SdkProcessCap(f.options);
  const slot = join(f.options.root, '0'); mkdirSync(slot); const record = join(slot, 'dead-owner.json');
  writeFileSync(record, JSON.stringify({ owner: 2147483647, child: null }));
  await assert.rejects(cap.query(f.query, { options: {} }), /timed out/);
  assert.equal(f.starts, 0); assert.equal(readdirSync(slot).length, 1);
  writeFileSync(record, JSON.stringify({ owner: 2147483647, child: 2147483646 }));
  const q = await cap.query(f.query, { options: {} }); for await (const _ of q) {}
  assert.equal(f.starts, 1); assert.equal(readdirSync(f.options.root).length, 0);
});

test('a lazy SDK query cannot spawn after close or after pressure withdraws admission', async t => {
  const f = fixture(t, 1); const cap = new SdkProcessCap(f.options);
  const lazy = ({ options }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: process.env }); yield 'unexpected';
  } });
  const closed = await cap.query(lazy, { options: {} }); await closed.close();
  await assert.rejects(async () => { for await (const _ of closed) {} }, /already closed/);
  assert.equal(readdirSync(cap.root).length, 0);
  const withdrawn = await cap.query(lazy, { options: {} }); f.state('warning');
  await assert.rejects(async () => { for await (const _ of withdrawn) {} }, /withdrew SDK spawn admission/);
  assert.equal(readdirSync(cap.root).length, 0);
});

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const abortError = () => Object.assign(new Error('SDK admission cancelled'), { code: 'ABORT_ERR' });
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export function governorAllowsClaude(path, now = Date.now()) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    const age = now / 1000 - s.sampled_at_epoch;
    return s.schema_version === 1 && Number.isFinite(age) && age >= -5 && age <= 30 &&
      s.pressure_level === 'normal' && s.kernel_pressure_level === 1 && s.blocked === false && s.admission?.claude === true;
  } catch { return false; }
}

// One directory per live child, shared by every route and Node instance.
// Release on actual child close, never on HTTP completion, abort, or iterator return.
export class SdkProcessCap {
  constructor({ root = join(homedir(), '.hermes/workspace/watchdog/claude-sdk-slots'),
    statePath = process.env.SUBSTATION_GOVERNOR_STATE || join(homedir(), '.hermes/workspace/watchdog/governor-fast-state.json'),
    limit = 8, maxQueue = 128, queueTimeoutMs = 300000, pollMs = 100 } = {}) {
    this.root = root; this.statePath = statePath;
    // Configuration can reduce the ceiling; raising it requires a code review.
    this.limit = Math.max(1, Math.min(8, Number.isInteger(limit) ? limit : 8));
    this.maxQueue = maxQueue; this.queueTimeoutMs = queueTimeoutMs; this.pollMs = pollMs; this.queue = [];
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  reserve() {
    for (let i = 0; i < this.limit; i++) {
      const dir = join(this.root, String(i));
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Remove only the dead holder's unique filename. A competing reaper
        // cannot unlink a newly acquired holder or remove a nonempty directory.
        try {
          const names = readdirSync(dir);
          if (!names.length && Date.now() - statSync(dir).mtimeMs > 30000) rmdirSync(dir);
          for (const name of names) {
            const f = join(dir, name); const record = JSON.parse(readFileSync(f, 'utf8'));
            // A dead parent with no recorded PID may have died between spawn
            // and persisting the PID. Keep that ambiguous lease for operator
            // review; reclaiming it could admit a ninth live orphan child.
            if (Number.isInteger(record.child) && record.child > 0 && !alive(record.owner) && !alive(record.child)) { unlinkSync(f); rmdirSync(dir); }
          }
        } catch {}
        continue;
      }
      const file = join(dir, randomUUID() + '.json');
      let released = false;
      const record = { owner: process.pid, child: null };
      const release = () => { if (released) return; released = true; try { unlinkSync(file); rmdirSync(dir); } catch {} };
      try { writeFileSync(file, JSON.stringify(record), { mode: 0o600 }); }
      catch (e) { try { rmdirSync(dir); } catch {} throw e; }
      return { release, child: pid => { record.child = pid; writeFileSync(file, JSON.stringify(record), { mode: 0o600 }); } };
    }
    return null;
  }
  async acquire(signal) {
    if (signal?.aborted) throw abortError();
    if (this.queue.length >= this.maxQueue) throw Object.assign(new Error('SDK admission queue full'), { statusCode: 503 });
    const ticket = {}; this.queue.push(ticket); const started = Date.now();
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        if (Date.now() - started >= this.queueTimeoutMs) throw Object.assign(new Error('SDK admission queue timed out'), { statusCode: 503 });
        if (this.queue[0] === ticket && governorAllowsClaude(this.statePath)) {
          const lease = this.reserve();
          if (lease) return lease;
        }
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, this.pollMs); signal?.addEventListener('abort', done, { once: true });
        });
      }
    } finally { this.queue.splice(this.queue.indexOf(ticket), 1); }
  }
  async query(query, input, requestSignal = null) {
    const controller = input.options?.abortController;
    const signal = requestSignal && controller?.signal ? AbortSignal.any([requestSignal, controller.signal]) : requestSignal || controller?.signal;
    const lease = await this.acquire(signal);
    let child; let spawned = false; let closed = false;
    const forwardAbort = () => controller?.abort();
    requestSignal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      if (!governorAllowsClaude(this.statePath)) throw Object.assign(new Error('Governor withdrew SDK admission'), { statusCode: 503 });
      const q = query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: options => {
        if (closed) throw new Error('SDK query already closed its process lease');
        if (spawned) throw new Error('SDK attempted a second child on one lease');
        if (signal?.aborted) throw abortError();
        if (!governorAllowsClaude(this.statePath)) throw Object.assign(new Error('Governor withdrew SDK spawn admission'), { statusCode: 503 });
        spawned = true;
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('close', lease.release);
        child.on('error', () => {}); // SDK also subscribes; close owns release.
        // Keep stderr drained as the SDK's standard transport does.
        child.stderr.resume();
        try { lease.child(child.pid); } catch (e) { child.kill('SIGKILL'); throw e; }
        return child;
      } } });
      const close = async () => {
        closed = true;
        requestSignal?.removeEventListener('abort', forwardAbort);
        const killTimer = child && setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
        killTimer?.unref();
        if (child) child.once('close', () => clearTimeout(killTimer));
        try { await q.close?.(); } finally { if (!spawned) lease.release(); }
      };
      return new Proxy(q, { get(target, key) {
        if (key === 'close') return close;
        if (key === Symbol.asyncIterator) return async function* () { try { yield* target; } finally { await close(); } };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } catch (e) { requestSignal?.removeEventListener('abort', forwardAbort); if (!child) lease.release(); else child.kill('SIGKILL'); throw e; }
  }
}

let singleton;
export function cappedSdkQuery(query, input, requestSignal = null) {
  singleton ||= new SdkProcessCap({ limit: Number(process.env.SUBSTATION_CLAUDE_PROCESS_CAP || 8) });
  return singleton.query(query, input, requestSignal);
}

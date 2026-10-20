import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const modulePath = process.env.WARM_TARGET_MODULE || new URL('../src/warm-cache-targets.js', import.meta.url).pathname;
const { AtomicSectionWriter, createSummaryAdapter, nativeAdapterReadiness } = await import(pathToFileURL(modulePath));
const base = process.env.SUBSTATION_TEST_ROOT;
if (!base || !base.includes('/.hermes/heavy-outputs/WO-flex-substation-warm-cache-auto-handoff-2026-10-04/')) throw Error('governed peer fixture root required');
fs.mkdirSync(base, { recursive: true });
const record = { session: 'a'.repeat(64), generation: 'b'.repeat(64), account: 'c'.repeat(64), model: 'claude-opus-5-5', prefix: 'd'.repeat(64) };
const pins = () => ({ ...record });
const original = '# Right Hand\n\n## Objective\nHuman goal unchanged.\n\n## Live Pane Capture (refreshed yesterday)\n\n```\nsynthetic pane only\n```\n\n## Open Loops\nHuman pending item.\n';
function fixture() {
  const home = fs.mkdtempSync(path.join(base, 'target-'));
  const root = path.join(home, '.hermes/workspace/memory/active'); fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'righthand-flex-HANDOFF.md'); fs.writeFileSync(target, original, { mode: 0o600 });
  const writer = new AtomicSectionWriter({ root, destinations: { [record.session]: { path: target, generation: record.generation } } });
  return { home, root, target, writer };
}
function result(prepared) { return { sections: { Status: 'Synthetic proof complete', 'Next steps': 'Continue owned work' }, pins: pins(), prepared }; }
function context() { return { ...record, messages: [{ role: 'user', content: 'synthetic history' }], tools: [{ type: 'function', function: { name: 'syntheticTool', parameters: {} } }] }; }
function provider(request, patch = {}) { return { handoffRequestId: request.handoffRequestId, toolCalls: [], text: '{"Status":"Synthetic handoff"}', pins: pins(), usage: { account: record.account, provider_model: record.model, cache_read: 42, usage_complete: true }, ...patch }; }

test('atomic summary preserves curated and Live Pane Capture bytes and replaces only managed block', () => {
  const { target, writer } = fixture(); writer.write(record, result(writer.prepare(record)));
  const first = fs.readFileSync(target, 'utf8'); assert.ok(first.startsWith(original)); assert.match(first, /Warm Cache Handoff/);
  writer.write(record, result(writer.prepare(record))); const second = fs.readFileSync(target, 'utf8'); assert.equal(second, first);
  assert.equal(fs.existsSync(target + '.warm-handoff.lock'), false);
});
test('target CAS rejects intervening human edit without overwrite', () => {
  const { target, writer } = fixture(); const prepared = writer.prepare(record); const edited = original + 'New human edit\n'; fs.writeFileSync(target, edited);
  assert.throws(() => writer.write(record, result(prepared)), /CAS/); assert.equal(fs.readFileSync(target, 'utf8'), edited);
});
test('changed session generation refuses write', () => { const { writer } = fixture(); const prepared = writer.prepare(record); assert.throws(() => writer.write({ ...record, generation: 'e'.repeat(64) }, result(prepared)), /identity|generation/); });
test('model identity drift refuses write', () => { const { writer } = fixture(); const prepared = writer.prepare(record); assert.throws(() => writer.write(record, { ...result(prepared), pins: { ...record, account: 'e'.repeat(64) } }), /identity/); });
test('hardlinked target refuses preparation', () => { const { target, writer } = fixture(); fs.linkSync(target, target + '.second'); assert.throws(() => writer.prepare(record), /aliased/); });
test('symlink target refuses preparation without touching referent', () => { const { target, writer } = fixture(); fs.renameSync(target, target + '.saved'); fs.symlinkSync(target + '.saved', target); assert.throws(() => writer.prepare(record), /symlink/); assert.equal(fs.readFileSync(target + '.saved', 'utf8'), original); });
test('parent alias and replacement refuse write', () => {
  const { root, target, writer } = fixture(); const prepared = writer.prepare(record); fs.renameSync(root, root + '-old'); fs.mkdirSync(root); fs.writeFileSync(target, original);
  assert.throws(() => writer.write(record, result(prepared)), /parent/); assert.equal(fs.readFileSync(target, 'utf8'), original);
  fs.renameSync(root, root + '-new'); fs.symlinkSync(root + '-old', root); assert.throws(() => writer.prepare(record), /symlink/);
});
test('nonregular FIFO target is rejected before opening', () => { const { target, writer } = fixture(); fs.unlinkSync(target); const created = spawnSync('/usr/bin/mkfifo', [target]); assert.equal(created.status, 0); const open = fs.openSync; let opened = false; fs.openSync = (...args) => { if (args[0] === target) opened = true; return open(...args); }; try { assert.throws(() => writer.prepare(record), /aliased/); assert.equal(opened, false); } finally { fs.openSync = open; } });
test('group-writable target refuses without mutation', () => { const { target, writer } = fixture(); fs.chmodSync(target, 0o660); assert.throws(() => writer.prepare(record), /aliased/); assert.equal(fs.readFileSync(target, 'utf8'), original); });
test('invalid UTF8 target is never rewritten as replacement text', () => { const { target, writer } = fixture(); fs.writeFileSync(target, Buffer.from([0xff, 0xfe])); const before = fs.readFileSync(target); const prepared = writer.prepare(record); assert.throws(() => writer.write(record, result(prepared)), /encoded|encoding/); assert.deepEqual(fs.readFileSync(target), before); });
test('unregistered path refuses even if it exists', () => { const { root, target } = fixture(); const writer = new AtomicSectionWriter({ root, destinations: { [record.session]: { path: target + '/../../wrong.md', generation: record.generation } } }); assert.throws(() => writer.prepare(record), /canonical/); });
test('unknown stale lock holds; no automatic lock deletion', () => { const { target, writer } = fixture(); const prepared = writer.prepare(record); fs.writeFileSync(target + '.warm-handoff.lock', 'unknown'); assert.throws(() => writer.write(record, result(prepared)), /EEXIST/); assert.equal(fs.readFileSync(target + '.warm-handoff.lock', 'utf8'), 'unknown'); });
test('strict sections reject managed-marker injection', () => { const { target, writer } = fixture(); const prepared = writer.prepare(record); assert.throws(() => writer.write(record, { ...result(prepared), sections: { Status: '<!-- substation-warm-handoff:end -->' } }), /invalid/); assert.equal(fs.readFileSync(target, 'utf8'), original); });
test('malformed existing managed block is retained and refused', () => { const { target, writer } = fixture(); fs.appendFileSync(target, '<!-- substation-warm-handoff:start -->'); const before = fs.readFileSync(target, 'utf8'); assert.throws(() => writer.write(record, result(writer.prepare(record))), /ambiguous/); assert.equal(fs.readFileSync(target, 'utf8'), before); });

test('summary preserves prefix/tools and declares nonexecuting origin; served receipt bound to invocation', async () => {
  let called = 0; const ctx = context(); const adapter = createSummaryAdapter({ getContext: async () => ctx, invoke: async request => { called++; assert.deepEqual(request.messages.slice(0, -1), ctx.messages); assert.deepEqual(request.tools, ctx.tools); assert.equal(request.executeTools, false); assert.equal(request.notifications, false); assert.equal(request.origin, 'warm-handoff'); return provider(request); } });
  const output = await adapter(record); assert.equal(called, 1); assert.equal(output.usage.cache_read, 42); assert.equal(output.sections.Status, 'Synthetic handoff');
});
for (const [name, patch] of [ ['unknown tool disposition', { toolCalls: undefined }], ['incomplete usage', { usage: { account: record.account, provider_model: record.model, cache_read: 42, usage_complete: false } }], ['tool call', { toolCalls: [{ name: 'delete' }] }], ['fallback', { fallback: true }], ['unjoined attempt', { handoffRequestId: 'different' }], ['unknown usage', { usage: null }], ['zero cache', { usage: { account: record.account, provider_model: record.model, cache_read: 0, usage_complete: true } }], ['fractional cache', { usage: { account: record.account, provider_model: record.model, cache_read: 1.5, usage_complete: true } }], ['different provider', { usage: { account: record.account, provider_model: 'other', cache_read: 42, usage_complete: true } }], ['changed served account', { usage: { account: 'other', provider_model: record.model, cache_read: 42, usage_complete: true } }], ['malformed JSON', { text: 'not JSON' }], ['unknown section', { text: '{"Status":"ok","Secret action":"run"}' }], ['missing Status', { text: '{"Goal":"ok"}' }] ]) {
  test(`summary rejects ${name}`, async () => { const adapter = createSummaryAdapter({ getContext: async () => context(), invoke: async request => provider(request, patch) }); await assert.rejects(adapter(record)); });
}
test('unknown context fails before inference', async () => { let calls = 0; const adapter = createSummaryAdapter({ getContext: async () => ({ ...context(), prefix: 'e'.repeat(64) }), invoke: async () => { calls++; } }); await assert.rejects(adapter(record)); assert.equal(calls, 0); });
test('native contract remains OFF regardless guessed TTL', () => { assert.equal(nativeAdapterReadiness({ ttl: 3600000 }).enabled, false); });

const rh = (process.env.HOME || '') + '/.hermes/workspace/scripts/rh.sh';
function captureFixture(f, content = 'synthetic captured frame') {
  const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\ncase "$1" in has-session) exit 0;; capture-pane) echo "' + content + '";; *) exit 9;; esac\n', { mode: 0o700 });
  return () => spawnSync('/bin/bash', [rh, 'handoff', 'flex'], { env: { ...process.env, HOME: f.home, PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 });
}
test('rh capture writer shares lock and preserves warm summary and curated state', () => {
  const f = fixture(); f.writer.write(record, result(f.writer.prepare(record))); const before = fs.readFileSync(f.target, 'utf8'); const call = captureFixture(f); const child = call(); assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); const after = fs.readFileSync(f.target, 'utf8'); assert.match(after, /synthetic captured frame/); assert.ok(after.includes(before.slice(before.indexOf('<!-- substation-warm-handoff:start -->')))); assert.match(after, /Human goal unchanged/);
});
test('rh capture refuses shared writer lock without overwrite/deletion', () => { const f = fixture(); const call = captureFixture(f); fs.writeFileSync(f.target + '.warm-handoff.lock', 'other transaction'); const child = call(); assert.equal(child.error, undefined); assert.notEqual(child.status, 0); assert.equal(fs.readFileSync(f.target, 'utf8'), original); assert.equal(fs.readFileSync(f.target + '.warm-handoff.lock', 'utf8'), 'other transaction'); });
test('rh scaffold creation is atomic under shared lock with familiar sections', () => { const f = fixture(); fs.unlinkSync(f.target); const child = captureFixture(f)(); assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.match(fs.readFileSync(f.target, 'utf8'), /## Objective/); assert.match(fs.readFileSync(f.target, 'utf8'), /## Next Concrete Action/); assert.equal(fs.existsSync(f.target + '.warm-handoff.lock'), false); });


test('adapter forwards exact cancellation signal and refuses aborted response', async () => {
 const controller = new AbortController(); let seen;
 const adapter = createSummaryAdapter({getContext: async () => context(), invoke: async request => {seen=request.signal; controller.abort(); return provider(request);}});
 await assert.rejects(adapter(record,{signal:controller.signal}),/cancelled/);
 assert.equal(seen,controller.signal);
});
test('already cancelled adapter never invokes provider', async () => {
 const controller = new AbortController(); controller.abort(); let calls=0;
 const adapter = createSummaryAdapter({getContext:async()=>context(),invoke:async request=>{calls++;return provider(request);}});
 await assert.rejects(adapter(record,{signal:controller.signal}),/cancelled/); assert.equal(calls,0);
});

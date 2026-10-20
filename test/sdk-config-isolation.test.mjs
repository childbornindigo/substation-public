// Regression (opt-in): per-account Claude Code config dir so GrowthBook flag
// caches of the two pool accounts (and interactive Claude Code sessions) can no
// longer overwrite each other.  Cache-cliff root-cause WO 2026-10-06, cause C6:
// in 1.3 days 47 of 2,141 SDK requests started with the other account's flag
// payload (system prompt intro/paragraph differ); 62 of 255 cache cliffs, 10.6M
// cache-write tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'substation-cfg-iso-')));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = home;
delete process.env.SUBSTATION_SDK_CONFIG_ISOLATION;
test.after(() => rmSync(home, { recursive: true, force: true }));
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, userID: 'u-1', numStartups: 99,
  cachedGrowthBookFeatures: { tengu_foreign_account_flag: true }, projects: { '/x': {} },
}));
const source = await import(process.env.CFG_ISOLATION_TEST_SOURCE || '../src/index.js');

test('off by default: no per-account config dir', () => {
  assert.equal(typeof source.sdkConfigDirForToken, 'function');
  assert.equal(source.sdkConfigDirForToken({ id: 'acct-a' }), null);
});

test('opt-in: one stable dir per account, seeded from the global config without project keys', () => {
  process.env.SUBSTATION_SDK_CONFIG_ISOLATION = '1';
  try {
    const a = source.sdkConfigDirForToken({ id: 'acct-a' });
    const b = source.sdkConfigDirForToken({ id: 'acct-b/../x' });
    assert.notEqual(a, b);
    assert.ok(a.startsWith(join(home, '.substation', 'sdk-config')));
    assert.ok(b.startsWith(join(home, '.substation', 'sdk-config')) && !b.includes('..'));
    const seed = JSON.parse(readFileSync(join(a, '.claude.json'), 'utf8'));
    // copied: onboarding state, ids and the current flag cache (cache-TTL eligibility lives
    // there, so a fresh dir must not start without it); project-specific keys are not.
    assert.deepEqual(seed, { hasCompletedOnboarding: true, userID: 'u-1', numStartups: 99, cachedGrowthBookFeatures: { tengu_foreign_account_flag: true } });
    assert.equal('projects' in seed, false);
    // the CLI's own flag cache for this account must survive later calls
    writeFileSync(join(a, '.claude.json'), JSON.stringify({ ...seed, cachedGrowthBookFeatures: { own: 1 } }));
    assert.equal(source.sdkConfigDirForToken({ id: 'acct-a' }), a);
    assert.deepEqual(JSON.parse(readFileSync(join(a, '.claude.json'), 'utf8')).cachedGrowthBookFeatures, { own: 1 });
  } finally { delete process.env.SUBSTATION_SDK_CONFIG_ISOLATION; }
});

test('opt-in: the real CLI runs with the account dir and receives it as CLAUDE_CONFIG_DIR', { timeout: 60000 }, async () => {
  process.env.SUBSTATION_SDK_CONFIG_ISOLATION = '1';
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', x => raw += x);
    req.on('end', () => {
      if (!req.url.includes('/messages')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      const ev = [
        ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ready' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [e, v] of ev) res.write(`event: ${e}\ndata: ${JSON.stringify(v)}\n\n`);
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'sk-offline-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
  const seen = [];
  const sdkMod = { ...sdk, query(args) { seen.push(args.options.env.CLAUDE_CONFIG_DIR); return sdk.query(args); } };
  const token = { id: 'acct-cfg-fixture', token: 'offline', activeRequests: 0 };
  try {
    const out = await source.invokeClaudeSDKWithTools(
      [{ role: 'user', content: 'probe' }],
      [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      'auto', { modelId: 'claude-opus-5-5' }, token.id, null, true, null,
      { sdkMod, z: {}, tokens: [token], markRequestStart() {}, markSuccess() {}, onUsageRow() {} }, null,
      { turn: 't', call: 'c', session: 's' });
    assert.equal(out.text, 'ready');
    assert.equal(seen[0], join(home, '.substation', 'sdk-config', 'acct-cfg-fixture'));
  } finally { delete process.env.SUBSTATION_SDK_CONFIG_ISOLATION; await new Promise(r => server.close(r)); }
});

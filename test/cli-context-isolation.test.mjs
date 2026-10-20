// Regression: SubStation's native SDK requests must not carry the host
// repo/memory context that the Claude Code CLI injects ahead of the cached
// conversation prefix.
//
// Cache-cliff root-cause WO 2026-10-06, cause C3.  The CLI child inherits the
// SubStation process cwd (the substation git checkout).  For that cwd it
// prepends two `<system-reminder>` attachments to every request:
//   - session_context: `gitStatus` (branch, working-tree status, last 5 commits)
//   - instructions: the project's auto-memory MEMORY.md (+ a "# Memory" section
//     in the system prompt)
// Both sit BEFORE the flattened conversation blocks, so any commit, branch
// switch, edited file or memory write by another lane in that checkout changes
// the cached prefix of every live session on its next request (13 cliffs and
// 2.5M cache-write tokens in 1.3 days; with the conversation prefix otherwise intact,
// every request whose instructions/session_context attachment changed was a cliff).
//
// This is an offline end-to-end check: the real Claude Code CLI binary talks
// to a local fake Anthropic server and we inspect the bytes it sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'substation-ctx-iso-')));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

// A host checkout the way the live service sees it: a git repo with a dirty
// working tree, and an auto-memory index for that path.
const repo = join(home, 'host-checkout');
mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q', '-b', 'host-branch-marker');
writeFileSync(join(repo, 'tracked.txt'), 'x');
git('add', '.');
git('commit', '-q', '-m', 'RECENT-COMMIT-MARKER');
writeFileSync(join(repo, 'GITSTATUS-UNTRACKED-MARKER.txt'), 'y');
const projectKey = repo.replace(/[^a-zA-Z0-9]/g, '-');
const memoryDir = join(home, 'projects', projectKey, 'memory');
mkdirSync(memoryDir, { recursive: true });
writeFileSync(join(memoryDir, 'MEMORY.md'), '- [AUTOMEMORY-INDEX-MARKER](m.md) - host memory index entry\n');
process.chdir(repo);

const source = await import(process.env.CLI_ISOLATION_TEST_SOURCE || '../src/index.js');

test('SDK request bytes contain no host git status or auto-memory context', { timeout: 60000 }, async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', x => raw += x);
    req.on('end', () => {
      if (!req.url.includes('/messages')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      bodies.push(raw);
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_iso', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ready' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [e, v] of events) res.write(`event: ${e}\ndata: ${JSON.stringify(v)}\n\n`);
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: 'sk-offline-fixture',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  });
  const seenOptions = [];
  const sdkMod = { ...sdk, query(args) { seenOptions.push(args.options); return sdk.query(args); } };
  const token = { id: 'ctx-isolation-fixture', token: 'offline', activeRequests: 0 };
  const deps = { sdkMod, z: {}, tokens: [token], markRequestStart() {}, markSuccess() {}, onUsageRow() {} };
  try {
    const out = await source.invokeClaudeSDKWithTools(
      [{ role: 'user', content: 'Offline isolation probe' }],
      [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      'auto', { modelId: 'claude-opus-5-5' }, token.id, null, true, null, deps, null,
      { turn: 't', call: 'c', session: 's' },
    );
    assert.equal(out.text, 'ready');
  } finally {
    await new Promise(r => server.close(r));
  }
  assert.ok(bodies.length >= 1, 'fake server saw at least one /v1/messages request');
  const wire = bodies.join('\n');
  for (const marker of ['GITSTATUS-UNTRACKED-MARKER', 'RECENT-COMMIT-MARKER', 'host-branch-marker', 'AUTOMEMORY-INDEX-MARKER']) {
    assert.equal(wire.includes(marker), false, `host context leaked into the cached prefix: ${marker}`);
  }
  // The isolation must be a property of how the CLI is launched, not of the cwd of the caller.
  assert.ok(seenOptions[0].cwd, 'SDK cwd is set explicitly');
  assert.notEqual(realpathSync(seenOptions[0].cwd), repo);
  assert.equal(existsSync(join(seenOptions[0].cwd, '.git')), false, 'SDK cwd is not a git checkout');
  assert.equal(seenOptions[0].env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

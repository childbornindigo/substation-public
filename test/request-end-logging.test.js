// Regression test for the "request logs a START line but never an END line"
// gap (WO 2026-09-25 fix2). Live evidence: a Muse setter request logged its
// START line (`SDK query (model=..., token=...)...`) and then NOTHING --
// no completion, error, timeout, or client-abort line ever appeared after it
// in ~/.substation/substation.log, so nobody could tell whether it hung,
// finished, or the caller gave up.
//
// This drives the real invoke-function boundary (invokeClaudeSDKWithTools,
// with its existing testDeps mock-SDK injection point), same spirit as
// sdk-noise-scrub.test.js and caller-tools-continuation.test.js, rather than
// unit-testing the logging helper in isolation -- proving the shared
// logRequestEnd() helper actually fires, exactly once, with an accurate
// outcome, for a real request through a real invoke function.
//
// Assertions read the REAL ~/.substation/substation.log (same file log()
// always writes to -- see log-single-write.test.js) filtered by a
// per-test-unique model id, so this never needs a subprocess (avoiding the
// documented top-level-setInterval hang trap) and never collides with the
// live SubStation process or other tests appending to the same file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { invokeClaudeSDKWithTools, sdkResumeCache } from '../src/index.js';

const LOG_PATH = join(homedir(), '.substation', 'substation.log');

const tools = [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }];
const deps = sdkMod => ({
  sdkMod,
  z: {},
  tokens: [{ id: 'test-token-request-end', token: 'test-token-request-end', activeRequests: 0 }],
  markRequestStart() {},
  markSuccess() {},
});

// Returns the single "Request end (...)" line for this model id, asserting
// there is exactly one -- proving logRequestEnd() fires exactly once per
// request, never zero (the original bug) and never twice.
function readSingleEndLine(modelId) {
  const contents = readFileSync(LOG_PATH, 'utf8');
  const lines = contents.split('\n').filter(
    line => line.includes('Request end (') && line.includes(`model=${modelId}`)
  );
  assert.equal(lines.length, 1, `expected exactly 1 END line for model=${modelId}, got ${lines.length}:\n${lines.join('\n')}`);
  return lines[0];
}

function parseEndLine(line) {
  const idMatch = line.match(/id=([0-9a-f]{8})/);
  const outcomeMatch = line.match(/outcome=([a-z-]+)\)/);
  const resumedMatch = line.match(/resumed=(yes|no|n\/a)/);
  const durationMatch = line.match(/duration=(\d+)ms/);
  const tokenMatch = line.match(/token=([^,]+)/);
  return {
    id: idMatch?.[1],
    outcome: outcomeMatch?.[1],
    resumed: resumedMatch?.[1],
    durationMs: durationMatch ? Number(durationMatch[1]) : null,
    token: tokenMatch?.[1],
  };
}

test('ok outcome: a normal successful request logs exactly one paired END line', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-req-end-ok-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() {
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: 'sdk-ok-1' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'all good' }] } };
    },
  };

  const result = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hello' }], tools, 'auto', model,
    'test-token-request-end', null, true, null, deps(sdkMod),
  );
  assert.equal(result.text, 'all good');

  const parsed = parseEndLine(readSingleEndLine(model.modelId));
  assert.equal(parsed.outcome, 'ok');
  assert.equal(parsed.resumed, 'no');
  assert.equal(parsed.token, 'test-token-request-end');
  assert.ok(parsed.id, 'END line must carry a requestId to pair with its START line');
  assert.ok(parsed.durationMs !== null && parsed.durationMs >= 0);
});

test('error outcome: every token failing (non-timeout) logs an END line with outcome=error', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-req-end-error-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() {
      throw new Error('simulated upstream 500 -- not a timeout, not a rate limit');
    },
  };

  await assert.rejects(
    invokeClaudeSDKWithTools(
      [{ role: 'user', content: 'hello' }], tools, 'auto', model,
      'test-token-request-end', null, true, null, deps(sdkMod),
    ),
  );

  const parsed = parseEndLine(readSingleEndLine(model.modelId));
  assert.equal(parsed.outcome, 'error');
  assert.equal(parsed.resumed, 'no');
});

test('hard-timeout outcome: a stalled query that never yields past init logs outcome=hard-timeout', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-req-end-hardtimeout-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() {
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: 'sdk-hang-1' };
      // Simulates the exact live symptom -- a query that produces a START
      // line and then never produces another message. No timers of our own
      // here (that would defeat the point): this dangling await is only
      // ever resolved by the function's own HARD_TIMEOUT_MS race.
      await new Promise(() => {});
    },
  };

  const prevHardTimeout = process.env.SUBSTATION_HARD_TIMEOUT_MS;
  process.env.SUBSTATION_HARD_TIMEOUT_MS = '50';
  try {
    await assert.rejects(
      invokeClaudeSDKWithTools(
        [{ role: 'user', content: 'hello' }], tools, 'auto', model,
        'test-token-request-end', null, true, null, deps(sdkMod),
      ),
      /hard timeout/,
    );
  } finally {
    if (prevHardTimeout === undefined) delete process.env.SUBSTATION_HARD_TIMEOUT_MS;
    else process.env.SUBSTATION_HARD_TIMEOUT_MS = prevHardTimeout;
  }

  const parsed = parseEndLine(readSingleEndLine(model.modelId));
  assert.equal(parsed.outcome, 'hard-timeout');
  assert.ok(parsed.durationMs >= 50, `expected duration >= 50ms (the hard timeout floor), got ${parsed.durationMs}`);
});

test('client-disconnect outcome: an aborted caller signal overrides the outcome even when the upstream call itself succeeded', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-req-end-disconnect-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() {
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: 'sdk-disconnect-1' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'too late, caller left' }] } };
    },
  };

  const clientAbort = new AbortController();
  clientAbort.abort(); // caller already gave up before the response arrived

  const result = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hello' }], tools, 'auto', model,
    'test-token-request-end', null, true, null, deps(sdkMod), clientAbort.signal,
  );
  assert.equal(result.text, 'too late, caller left', 'the upstream call itself still completes normally');

  const parsed = parseEndLine(readSingleEndLine(model.modelId));
  assert.equal(parsed.outcome, 'client-disconnect', 'a disconnected caller must be logged, not silently reported as ok');
});

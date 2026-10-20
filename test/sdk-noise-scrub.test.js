// Regression test for the "No response requested." / "Continue from where
// you left off." history-pollution bug (see CONTEXT.md and the 2026-09-25
// work order). The Agent SDK can synthesize these two turns internally when
// a resumed session has nothing new to react to -- neither string is
// authored anywhere in SubStation or Hermes (confirmed by repo-wide grep).
// This is the belt-and-braces layer, deliberately independent of the
// resume-cache root-cause fix (see caller-tools-continuation.test.js): it
// must hold even if some other path we don't control re-triggers the same
// SDK recovery idiom.
//
// Per CONTEXT.md's own note, a formatter-only test would not establish real
// behavior -- both tests below drive invokeClaudeSDKWithTools itself (the
// actual SDK bridge boundary), not just formatMessagesForSDK in isolation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeClaudeSDKWithTools, sdkResumeCache } from '../src/index.js';

const model = { modelId: 'claude-noise-scrub-regression' };
const tools = [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }];
const deps = sdkMod => ({
  sdkMod,
  z: {},
  tokens: [{ id: 'test-token', token: 'test-token', activeRequests: 0 }],
  markRequestStart() {},
  markSuccess() {},
});

test('a bare "No response requested." SDK reply is never returned as real output (belt-and-braces (a))', async () => {
  sdkResumeCache.clear();
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query({ options }) {
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: 'sdk-noop-1' };
      // Models the exact SDK-synthesized recovery idiom: a resumed/aborted
      // session answering a nudge with nothing new to say.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'No response requested.' }] } };
    },
  };
  const result = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'Anything new?' }], tools, 'auto', model,
    'test-token', null, true, null, deps(sdkMod),
  );
  assert.equal(result.text, '', 'the literal sentinel text must be treated as empty/no-op, not returned verbatim');
});

test('bare "Continue from where you left off." / "No response requested." history turns are scrubbed before the next SDK prompt, and cannot re-trigger a second tool dispatch (belt-and-braces (b))', async () => {
  sdkResumeCache.clear();
  const calls = [];
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query({ prompt, options }) {
      if (typeof prompt !== 'string') {
        const messages = [];
        for await (const message of prompt) messages.push(message);
        assert.equal(messages.length, 1);
        prompt = messages[0].message.content.map(block => block.text).join('\n\n');
      }
      calls.push({ prompt, resume: options.resume });
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: `sdk-${calls.length}` };
      if (calls.length === 1) {
        yield { type: 'assistant', message: { content: [
          { type: 'tool_use', id: 'call-1', name: 'mcp__caller-tools__lookup', input: {} },
        ] } };
      } else {
        // If the poisoned nudge/no-op turns leaked into this prompt, a
        // confused resumed-feeling session would be the exact condition
        // that caused the model to reissue the SAME tool call a second
        // time in production (the observed "ran twice" / duplicate-enqueue
        // symptom). Simulate that failure mode: only respond cleanly with
        // text if the prompt is clean of the noise turns.
        const poisoned = prompt.includes('No response requested') || prompt.includes('Continue from where you left off');
        if (poisoned) {
          yield { type: 'assistant', message: { content: [
            { type: 'tool_use', id: 'call-2', name: 'mcp__caller-tools__lookup', input: {} },
          ] } };
        } else {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'used result' }] } };
        }
      }
    },
  };

  const first = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'Find item' }], tools, 'required', model,
    'test-token', null, true, null, deps(sdkMod),
  );
  assert.deepEqual(first.toolCalls?.map(call => call.id), ['call-1']);

  // History as Hermes would replay it: the real tool exchange, PLUS a
  // poisoned nudge/no-op pair that slipped in from upstream (the SDK, or
  // any caller we don't fully control) sitting in between.
  const historyWithNoise = [
    { role: 'user', content: 'Find item' },
    { role: 'assistant', content: null, tool_calls: first.toolCalls },
    { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: 'found' },
    { role: 'user', content: 'Continue from where you left off.' },
    { role: 'assistant', content: 'No response requested.' },
  ];

  const second = await invokeClaudeSDKWithTools(
    historyWithNoise, tools, 'auto', model, 'test-token', null, true, null, deps(sdkMod),
  );

  assert.equal(calls.length, 2, 'the noise turns must not cause an extra SDK query');
  assert.ok(
    !calls[1].prompt.includes('No response requested') && !calls[1].prompt.includes('Continue from where you left off'),
    'the noise turns must be scrubbed out of the prompt sent to the SDK',
  );
  assert.equal(second.text, 'used result', 'the real tool result must still reach the model normally');
  assert.equal(second.toolCalls, undefined, 'the same tool call must not be dispatched a second time');
});

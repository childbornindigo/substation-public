import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessagesForSDK, invokeClaudeSDKWithTools, sdkResumeCache } from '../src/index.js';

const model = { modelId: 'claude-caller-tools-regression' };
const tools = [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }];
const deps = sdkMod => ({
  sdkMod,
  z: {},
  tokens: [{ id: 'test-token', token: 'test-token', activeRequests: 0 }],
  markRequestStart() {},
  markSuccess() {},
});

test('caller tool result reaches exactly the next model turn without resuming an aborted SDK session', async () => {
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
      calls.push({ prompt, resume: options.resume, aborted: options.abortController.signal.aborted });
      yield { type: 'system', subtype: 'init', model: model.modelId, session_id: `sdk-${calls.length}` };
      if (calls.length === 1) {
        yield { type: 'assistant', message: { content: [
          { type: 'tool_use', id: 'call-1', name: 'mcp__caller-tools__lookup', input: {} },
        ] } };
      } else {
        const seesResult = !options.resume && prompt.includes('lookup') && prompt.includes('call-1') && prompt.includes('found');
        yield { type: 'assistant', message: { content: [{ type: 'text', text: seesResult ? 'used result' : 'No response requested.' }] } };
      }
    },
  };
  const first = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'Find item' }], tools, 'required', model,
    'test-token', null, true, null, deps(sdkMod),
  );
  assert.deepEqual(first.toolCalls?.map(call => [call.id, call.function.name]), [['call-1', 'lookup']]);
  const second = await invokeClaudeSDKWithTools(
    [
      { role: 'user', content: 'Find item' },
      { role: 'assistant', content: null, tool_calls: first.toolCalls },
      { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: 'found' },
    ], tools, 'auto', model, 'test-token', null, true, null, deps(sdkMod),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, undefined);
  assert.equal(second.text, 'used result');
});

test('fresh continuation keeps parallel call identities and error status', () => {
  const prompt = formatMessagesForSDK([
    { role: 'user', content: 'Check both' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call-a', function: { name: 'lookup', arguments: '{"item":"a"}' } },
      { id: 'call-b', function: { name: 'lookup', arguments: '{"item":"b"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call-a', name: 'lookup', content: 'found a' },
    { role: 'tool', tool_call_id: 'call-b', name: 'lookup', is_error: true, content: 'not found' },
  ]);
  assert.match(prompt, /tool_call id="call-a" name="lookup"/);
  assert.match(prompt, /tool_call id="call-b" name="lookup"/);
  assert.match(prompt, /tool_result id="call-a" name="lookup" status=ok]: found a/);
  assert.match(prompt, /tool_result id="call-b" name="lookup" status=error]: not found/);
});

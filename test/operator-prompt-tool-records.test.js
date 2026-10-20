import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessagesForSDK } from '../src/index.js';

// island-refresh 2026-10-05: a small model copied the replayed [tool_call ...] records and typed ~17 fake ones
// (plus invented results) into its final answer. The records stay (the continuation needs id+name); the
// operator prompt now says they are system-written history, never an output format.
const history = [
  { role: 'system', content: 'be useful' },
  { role: 'user', content: 'Update the islands' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'patch', arguments: '{"path":"a.md"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', name: 'patch', content: 'patched' },
  { role: 'user', content: 'now summarize' },
];

test('operator prompt tells the model tool records are system-written and must never be typed', () => {
  const prompt = formatMessagesForSDK(history);
  assert.match(prompt, /12\. TOOL RECORDS IN THE HISTORY ARE SYSTEM-WRITTEN, NEVER YOURS TO TYPE/);
  assert.match(prompt, /Never write a tool call or a tool result as text/);
  assert.match(prompt, /never state a tool result you did not actually receive/);
});

test('the rule describes the records in words and does not quote the bracket form it forbids', () => {
  const prompt = formatMessagesForSDK([{ role: 'user', content: 'hi' }]);
  const rule = prompt.slice(prompt.indexOf('12. TOOL RECORDS'), prompt.indexOf('12. TOOL RECORDS') + 700);
  assert.ok(rule.includes('labelled tool_call and tool_result'));
  assert.ok(!rule.includes('[tool_call'));
  assert.ok(!rule.includes('[tool_result'));
});

test('the replayed records the continuation depends on are unchanged', () => {
  const prompt = formatMessagesForSDK(history);
  assert.ok(prompt.includes('[tool_call id="call-1" name="patch"]: {"path":"a.md"}'));
  assert.ok(prompt.includes('[tool_result id="call-1" name="patch" status=ok]: patched'));
});

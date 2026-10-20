import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeReasoningEffort,
  resolveClaudeReasoningEffort,
  resolveCodexReasoningEffort,
  resolveRequestedReasoningEffort,
} from '../src/reasoning-effort.js';

const codexInfo = { modelId: 'gpt-5.6-sol', apiModel: 'gpt-5.6-sol', reasoningEffort: 'max' };

test('normalizes only supported request effort values', () => {
  assert.equal(normalizeReasoningEffort('LOW'), 'low');
  assert.equal(normalizeReasoningEffort(' medium '), 'medium');
  assert.equal(normalizeReasoningEffort('high'), 'high');
  assert.equal(normalizeReasoningEffort('max'), 'max');
  assert.equal(normalizeReasoningEffort('xhigh'), null);
  assert.equal(normalizeReasoningEffort('minimal'), null);
  assert.equal(normalizeReasoningEffort(''), null);
});

test('accepts Hermes/OpenAI-compatible request shapes', () => {
  assert.equal(resolveRequestedReasoningEffort({ reasoning_effort: 'low' }), 'low');
  assert.equal(resolveRequestedReasoningEffort({ reasoning: { effort: 'medium' } }), 'medium');
  assert.equal(resolveRequestedReasoningEffort({ extra_body: { reasoning_effort: 'high' } }), 'high');
  assert.equal(resolveRequestedReasoningEffort({ extra_body: { reasoning: { effort: 'max' } } }), 'max');
  assert.equal(resolveRequestedReasoningEffort({ output_config: { effort: 'low' } }), 'low');
  assert.equal(resolveRequestedReasoningEffort({ extra_body: { output_config: { effort: 'high' } } }), 'high');
});

test('invalid or missing request effort falls back by path', () => {
  assert.deepEqual(resolveClaudeReasoningEffort(null), { effort: 'high', source: 'default' });
  assert.deepEqual(resolveClaudeReasoningEffort('xhigh'), { effort: 'high', source: 'default' });
  assert.deepEqual(resolveCodexReasoningEffort(null, codexInfo), { effort: 'max', source: 'default' });
  assert.deepEqual(resolveCodexReasoningEffort('minimal', codexInfo), { effort: 'max', source: 'default' });
});

test('request effort overrides defaults by path', () => {
  assert.deepEqual(resolveClaudeReasoningEffort('low'), { effort: 'low', source: 'request' });
  assert.deepEqual(resolveCodexReasoningEffort('high', codexInfo), { effort: 'high', source: 'request' });
});

test('path resolvers expose body-builder decisions', () => {
  assert.equal(resolveClaudeReasoningEffort('low').effort, 'low');
  assert.equal(resolveClaudeReasoningEffort('invalid').effort, 'high');
  assert.equal(resolveCodexReasoningEffort('medium', codexInfo).effort, 'medium');
  assert.equal(resolveCodexReasoningEffort(undefined, codexInfo).effort, 'max');
});

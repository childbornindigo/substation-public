// Regression test for WO-flex-substation-register-claude-sonnet-5-5
// (2026-09-28): Anthropic serves claude-sonnet-5.5 on our accounts, but
// SubStation didn't know the model id. resolveModel() (src/index.js) falls
// back to claude-sonnet-4-6 for any id missing from MODEL_MAP, and the
// response's `model` field just echoes the request -- so a caller asking
// for claude-sonnet-5-5 got silently downgraded to sonnet-4-6 with no
// visible error.
//
// RED (pre-fix): claude-sonnet-5-5 / sonnet-5.5 / sonnet-5-5 are absent from
// MODEL_MAP, so resolveModel falls through to the claude-sonnet-4-6 default.
// GREEN (post-fix): each alias resolves to modelId 'claude-sonnet-5-5', with
// MODEL_CONFIG shaped identically to claude-sonnet-5.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModel } from '../src/index.js';

test('resolveModel resolves claude-sonnet-5-5 and its aliases, not the sonnet-4-6 fallback', () => {
  for (const alias of ['claude-sonnet-5-5', 'sonnet-5.5', 'sonnet-5-5']) {
    const resolved = resolveModel(alias);
    assert.equal(resolved.modelId, 'claude-sonnet-5-5', `alias '${alias}' should resolve to claude-sonnet-5-5, got ${resolved.modelId}`);
    assert.equal(resolved.provider, 'anthropic');
  }
});

test('claude-sonnet-5-5 has the same config shape as claude-sonnet-5', () => {
  const sonnet5 = resolveModel('claude-sonnet-5');
  const sonnet55 = resolveModel('claude-sonnet-5-5');
  assert.equal(sonnet55.maxTokens, sonnet5.maxTokens);
  assert.equal(sonnet55.adaptive, sonnet5.adaptive);
  assert.equal(sonnet55.provider, sonnet5.provider);
  assert.equal(sonnet55.contextWindow, sonnet5.contextWindow);
});

test('a namespaced token-pinned id (claude-sonnet-5-5/acct2) still resolves correctly', () => {
  const resolved = resolveModel('some-provider/claude-sonnet-5-5');
  assert.equal(resolved.modelId, 'claude-sonnet-5-5');
});

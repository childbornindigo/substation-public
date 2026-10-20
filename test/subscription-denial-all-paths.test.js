// subscription-denial-all-paths.test.js — WO-flex-substation-fix4-bench-all-paths
// (2026-09-25/26): proves the confirmed (2x consecutive), last-token-guarded
// subscription-denial handling is wired into ALL FOUR Anthropic invoke paths,
// not just invokeClaudeSDKWithTools (the only one fbb8f93 originally covered).
//
// The isolated safety-property proofs for handleSubscriptionDenial itself
// (confirmation count, last-token guard, reset-on-success/non-match) live in
// auth-policy.test.mjs. This file proves each of the 4 call sites actually
// calls it, with the same real `markDead`/`log` used in production (never
// stubbed out here), so a regression that quietly drops the wiring at one of
// the 4 sites — or that lets the generic single-occurrence isAuthError/statusCode
// branches shadow it — is caught.
//
// Every mocked token id is unique per test so no two tests share consecutive-
// denial-counter state on the same object.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  invokeClaudeSDKWithTools,
  invokeClaudeSDK,
  invokeClaudeDirect,
  invokeClaudeMessagesAPIWithTools,
  sdkResumeCache,
} from '../src/index.js';

const DENIAL_MESSAGE = 'Claude Code returned an error result: Your organization has disabled Claude subscription access';
const tools = [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }];

// ---------------------------------------------------------------------------
// 1. invokeClaudeSDKWithTools (already had SOME denial handling pre-fix4 —
//    this proves it now uses the confirm+last-token-guarded policy)
// ---------------------------------------------------------------------------

test('invokeClaudeSDKWithTools: 1st occurrence does not bench, 2nd confirms and benches when a backup token exists', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-tools-denial-bench-${Date.now()}` };
  const primary = { id: 'tools-primary-a', token: 'tok-a', activeRequests: 0, dead: false };
  const backup = { id: 'tools-backup-a', token: 'tok-b', activeRequests: 0, dead: false };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() { throw new Error(DENIAL_MESSAGE); },
  };
  const deps = { sdkMod, z: {}, tokens: [primary, backup], markRequestStart() {}, markSuccess() {} };

  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-primary-a', null, true, null, deps,
  ));
  assert.equal(primary.dead, false, '1st occurrence must not bench, even though a backup token exists');

  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-primary-a', null, true, null, deps,
  ));
  assert.equal(primary.dead, true, '2nd consecutive occurrence with a live backup present must bench');
  assert.equal(primary.deadType, 'auth');
});

test('invokeClaudeSDKWithTools: confirmed denial on the LAST live Anthropic token is spared, not benched', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-tools-denial-spare-${Date.now()}` };
  const onlyToken = { id: 'tools-only-live-token', token: 'tok-only', activeRequests: 0, dead: false };
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() { throw new Error(DENIAL_MESSAGE); },
  };
  const deps = { sdkMod, z: {}, tokens: [onlyToken], markRequestStart() {}, markSuccess() {} };

  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-only-live-token', null, true, null, deps,
  ));
  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-only-live-token', null, true, null, deps,
  ));
  assert.equal(onlyToken.dead, false, 'the pool\'s only live Anthropic token must never be benched on this error, confirmed or not');
});

test('invokeClaudeSDKWithTools: a real success between two denials resets the confirmation count -- they are not "consecutive"', async () => {
  sdkResumeCache.clear();
  const model = { modelId: `claude-tools-denial-reset-${Date.now()}` };
  // A backup token is present specifically so this test can distinguish "the
  // reset happened" from "the last-token guard happened to save it anyway" --
  // with a backup live, only a truly confirmed (2x back-to-back, no success
  // between) denial would bench `token`.
  const token = { id: 'tools-reset-a', token: 'tok-reset', activeRequests: 0, dead: false };
  const backup = { id: 'tools-reset-backup', token: 'tok-reset-backup', activeRequests: 0, dead: false };
  let calls = 0;
  const sdkMod = {
    tool: (name) => ({ name }),
    createSdkMcpServer: config => config,
    async *query() {
      calls++;
      if (calls === 2) {
        // A genuine success sits between the two denial occurrences.
        yield { type: 'system', subtype: 'init', model: model.modelId, session_id: `sdk-reset-${calls}` };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fine for now' }] } };
        return;
      }
      throw new Error(DENIAL_MESSAGE);
    },
  };
  const deps = { sdkMod, z: {}, tokens: [token, backup], markRequestStart() {}, markSuccess() {} };

  // 1st denial -- unconfirmed, as expected.
  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-reset-a', null, true, null, deps,
  ));
  assert.equal(token.dead, false);

  // A real success in between must reset the counter. If it did NOT reset,
  // the 3rd call's denial below would land as a false "2nd consecutive" and,
  // with a live backup present, WOULD get benched -- exactly the bug this
  // test exists to catch.
  const result = await invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-reset-a', null, true, null, deps,
  );
  assert.equal(result.text, 'fine for now');

  // 3rd call is a 2nd denial occurrence, but it followed a real success --
  // it must be treated as a FRESH 1st occurrence, not a confirmed 2nd, even
  // though a live backup exists that would otherwise make benching "safe".
  await assert.rejects(invokeClaudeSDKWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'tools-reset-a', null, true, null, deps,
  ));
  assert.equal(token.dead, false, 'a denial after an intervening success must not be treated as the 2nd of a consecutive pair, even with a live backup present');
});

// ---------------------------------------------------------------------------
// 2. invokeClaudeSDK
// ---------------------------------------------------------------------------

test('invokeClaudeSDK: 1st occurrence does not bench, 2nd confirms and benches when a backup token exists', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929' };
  const primary = { id: 'sdk-primary-a', token: 'tok-a', activeRequests: 0, dead: false, lastSuccess: 1, errorCount: 0 };
  const backup = { id: 'sdk-backup-a', token: 'tok-b', activeRequests: 0, dead: false, lastSuccess: 1, errorCount: 0 };
  const testDeps = {
    tokens: [primary, backup],
    querySDK: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeSDK(
    [{ role: 'user', content: 'hi' }], model, null, 'sdk-primary-a', null, null, null, testDeps,
  ));
  assert.equal(primary.dead, false, '1st occurrence must not bench');

  await assert.rejects(invokeClaudeSDK(
    [{ role: 'user', content: 'hi' }], model, null, 'sdk-primary-a', null, null, null, testDeps,
  ));
  assert.equal(primary.dead, true, '2nd consecutive occurrence with a live backup present must bench');
  assert.equal(primary.deadType, 'auth');
});

test('invokeClaudeSDK: confirmed denial on the LAST live Anthropic token is spared, not benched', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929' };
  const onlyToken = { id: 'sdk-only-live-token', token: 'tok-only', activeRequests: 0, dead: false, lastSuccess: 1, errorCount: 0 };
  const testDeps = {
    tokens: [onlyToken],
    querySDK: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeSDK(
    [{ role: 'user', content: 'hi' }], model, null, 'sdk-only-live-token', null, null, null, testDeps,
  ));
  await assert.rejects(invokeClaudeSDK(
    [{ role: 'user', content: 'hi' }], model, null, 'sdk-only-live-token', null, null, null, testDeps,
  ));
  assert.equal(onlyToken.dead, false, 'the pool\'s only live Anthropic token must never be benched on this error');
});

// ---------------------------------------------------------------------------
// 3. invokeClaudeDirect (dead code today -- zero call sites -- but the WO is
//    explicit that it still needs this fix applied)
// ---------------------------------------------------------------------------

test('invokeClaudeDirect: 1st occurrence does not bench, 2nd confirms and benches when a backup token exists', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929', maxTokens: 8192 };
  const primary = { id: 'direct-primary-a', token: 'tok-a', activeRequests: 0, dead: false };
  const backup = { id: 'direct-backup-a', token: 'tok-b', activeRequests: 0, dead: false };
  const testDeps = {
    tokens: [primary, backup],
    makeAnthropicDirectRequest: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeDirect(
    [{ role: 'user', content: 'hi' }], model, 'direct-primary-a', null, null, null, testDeps,
  ));
  assert.equal(primary.dead, false, '1st occurrence must not bench');

  await assert.rejects(invokeClaudeDirect(
    [{ role: 'user', content: 'hi' }], model, 'direct-primary-a', null, null, null, testDeps,
  ));
  assert.equal(primary.dead, true, '2nd consecutive occurrence with a live backup present must bench');
  assert.equal(primary.deadType, 'auth');
});

test('invokeClaudeDirect: confirmed denial on the LAST live Anthropic token is spared, not benched', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929', maxTokens: 8192 };
  const onlyToken = { id: 'direct-only-live-token', token: 'tok-only', activeRequests: 0, dead: false };
  const testDeps = {
    tokens: [onlyToken],
    makeAnthropicDirectRequest: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeDirect(
    [{ role: 'user', content: 'hi' }], model, 'direct-only-live-token', null, null, null, testDeps,
  ));
  await assert.rejects(invokeClaudeDirect(
    [{ role: 'user', content: 'hi' }], model, 'direct-only-live-token', null, null, null, testDeps,
  ));
  assert.equal(onlyToken.dead, false, 'the pool\'s only live Anthropic token must never be benched on this error');
});

// ---------------------------------------------------------------------------
// 4. invokeClaudeMessagesAPIWithTools (dead code today -- zero call sites --
//    but the WO is explicit that it still needs this fix applied)
// ---------------------------------------------------------------------------

test('invokeClaudeMessagesAPIWithTools: 1st occurrence does not bench, 2nd confirms and benches when a backup token exists', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929', maxTokens: 8192 };
  const primary = { id: 'msgapi-primary-a', token: 'tok-a', activeRequests: 0, dead: false, cooldownUntil: null };
  const backup = { id: 'msgapi-backup-a', token: 'tok-b', activeRequests: 0, dead: false, cooldownUntil: null };
  const testDeps = {
    tokens: [primary, backup],
    makeAnthropicRequest: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeMessagesAPIWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'msgapi-primary-a', null, testDeps,
  ));
  assert.equal(primary.dead, false, '1st occurrence must not bench');

  await assert.rejects(invokeClaudeMessagesAPIWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'msgapi-primary-a', null, testDeps,
  ));
  assert.equal(primary.dead, true, '2nd consecutive occurrence with a live backup present must bench');
  assert.equal(primary.deadType, 'auth');
});

test('invokeClaudeMessagesAPIWithTools: confirmed denial on the LAST live Anthropic token is spared, not benched', async () => {
  const model = { modelId: 'claude-sonnet-4-5-20250929', maxTokens: 8192 };
  const onlyToken = { id: 'msgapi-only-live-token', token: 'tok-only', activeRequests: 0, dead: false, cooldownUntil: null };
  const testDeps = {
    tokens: [onlyToken],
    makeAnthropicRequest: async () => { throw new Error(DENIAL_MESSAGE); },
  };

  await assert.rejects(invokeClaudeMessagesAPIWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'msgapi-only-live-token', null, testDeps,
  ));
  await assert.rejects(invokeClaudeMessagesAPIWithTools(
    [{ role: 'user', content: 'hi' }], tools, 'auto', model, 'msgapi-only-live-token', null, testDeps,
  ));
  assert.equal(onlyToken.dead, false, 'the pool\'s only live Anthropic token must never be benched on this error');
});

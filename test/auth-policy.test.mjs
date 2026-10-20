// auth-policy.test.mjs — TDD proof that a single transient 401/403 no longer
// benches the sole valid OAuth token. Plain node ESM, no test framework.
//
// Bug: a single transient 401/403 from Anthropic's edge benched the sole valid
// OAuth token for 24h → daily "No Anthropic OAuth tokens found" outage.
// Fix lives in ../dist/auth-policy.js (AUTH_FAIL_THRESHOLD=3, AUTH_DEAD_REVIVE_MS=5min).

import assert from 'node:assert/strict';
import {
  isAuthError,
  isDisabledSubscriptionError,
  handleSubscriptionDenial,
  recordSubscriptionDenial,
  resetSubscriptionDenials,
  SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD,
  recordAuthFailure,
  resetAuthFailures,
  AUTH_FAIL_THRESHOLD,
  AUTH_DEAD_REVIVE_MS,
  DEAD_REVIVE_MS,
} from '../dist/auth-policy.js';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS: ${label}`);
  } catch (e) {
    fail(`${label}\n    ${e.message}`);
  }
}

// (a) Auth classification and the definitive SDK tools-path denial
console.log('(a) auth classification and SDK tools-path denial:');
check('statusCode 403 → true', () => assert.equal(isAuthError({ statusCode: 403 }), true));
check('statusCode 401 → true', () => assert.equal(isAuthError({ statusCode: 401 }), true));
check("'organization does not have access' → true", () =>
  assert.equal(isAuthError({ message: 'organization does not have access' }), true));
check("disabled Claude subscription → auth failure", () =>
  assert.equal(isAuthError({ message: 'Claude Code returned an error result: Your organization has disabled Claude subscription access' }), true));
check("disabled subscription → definitive failure for SDK tools path", () =>
  assert.equal(isDisabledSubscriptionError({ message: 'Your organization has disabled Claude subscription access' }), true));
check("transient timeout → no definitive auth bench in SDK tools path", () =>
  assert.equal(isDisabledSubscriptionError({ message: 'request timeout' }), false));
check('a CONFIRMED (2x consecutive) denial benches when other live Anthropic tokens exist', () => {
  const entry = { id: 'acct1' };
  const calls = [];
  const markDead = (token, type) => calls.push([token, type]);
  const err = { message: 'Your organization has disabled Claude subscription access' };
  const first = handleSubscriptionDenial(err, entry, markDead, 1 /* other live token */, () => {});
  assert.equal(first.isSubscriptionDenial, true);
  assert.equal(first.confirmed, false);
  assert.equal(first.benched, false, '1st occurrence must NEVER bench');
  assert.deepEqual(calls, [], 'markDead must not be called on a single occurrence');
  const second = handleSubscriptionDenial(err, entry, markDead, 1, () => {});
  assert.equal(second.isSubscriptionDenial, true);
  assert.equal(second.confirmed, true);
  assert.equal(second.benched, true);
  assert.deepEqual(calls, [[entry, 'auth']]);
});
check('a transient (non-matching) error is never treated as a subscription denial', () => {
  const calls = [];
  const result = handleSubscriptionDenial(
    { message: 'request timeout' }, {}, (...args) => calls.push(args), 5, () => {}
  );
  assert.equal(result.isSubscriptionDenial, false);
  assert.equal(result.benched, false);
  assert.deepEqual(calls, []);
});
check("'no_biscuit_no_service' → false (Codex session stall, not dead token)", () =>
  assert.equal(isAuthError({ message: 'Codex API error: no_biscuit_no_service (unknown)' }), false));
check("'request timeout' → false", () =>
  assert.equal(isAuthError({ message: 'request timeout' }), false));
check('empty {} → false', () => assert.equal(isAuthError({}), false));

// (b) THE KEY PROOF — a single 403 does NOT bench
console.log('(b) single 403 does NOT bench (needs 3 consecutive):');
{
  const entry = {};
  const r1 = recordAuthFailure(entry);
  const r2 = recordAuthFailure(entry);
  const r3 = recordAuthFailure(entry);
  check('1st failure (1/3) → false (stays in service)', () => assert.equal(r1, false));
  check('2nd failure (2/3) → false (stays in service)', () => assert.equal(r2, false));
  check('3rd failure (3/3) → true (now benches)', () => assert.equal(r3, true));
}

// (c) Success resets the transient count
console.log('(c) a good response resets the count:');
{
  const entry = {};
  recordAuthFailure(entry); // 1/3
  recordAuthFailure(entry); // 2/3
  resetAuthFailures(entry); // success clears
  const afterReset = recordAuthFailure(entry); // back to 1/3
  check('after reset, next failure → false (count back to 1/3)', () =>
    assert.equal(afterReset, false));
  check('reset zeroed the counter before increment', () =>
    assert.equal(entry._consecutiveAuthFails, 1));
}

// (d) Constants prove the 24h→5min and threshold fixes
console.log('(d) constants:');
check('AUTH_DEAD_REVIVE_MS === 5*60*1000 (NOT 24h)', () =>
  assert.equal(AUTH_DEAD_REVIVE_MS, 5 * 60 * 1000));
check('AUTH_FAIL_THRESHOLD === 3', () => assert.equal(AUTH_FAIL_THRESHOLD, 3));
check('DEAD_REVIVE_MS === 30*60*1000 (unchanged rate-limit revive)', () =>
  assert.equal(DEAD_REVIVE_MS, 30 * 60 * 1000));
// Guard against a silent regression back to the 24h bench.
check('AUTH_DEAD_REVIVE_MS is NOT the old 24h value', () =>
  assert.notEqual(AUTH_DEAD_REVIVE_MS, 24 * 60 * 60 * 1000));

// REAL-GUARD PROOF — this test distinguishes OLD-broken from NEW-fixed behavior.
// Under the OLD policy (threshold=1) a single failure WOULD bench. If this test
// harness were toothless it would not catch that; here we prove it does.
console.log('(guard) OLD policy (threshold=1) WOULD bench on a single failure:');
{
  const oldEntry = {};
  const benchedImmediately = recordAuthFailure(oldEntry, 1);
  check('recordAuthFailure(oldEntry, 1) → true (old bug reproduced)', () =>
    assert.equal(benchedImmediately, true));
  // And confirm the NEW default (threshold=3) does NOT bench that same first failure.
  const newEntry = {};
  check('same first failure under default threshold=3 → false (bug fixed)', () =>
    assert.equal(recordAuthFailure(newEntry), false));
}

// (e) Fix4 (WO-flex-substation-fix4-bench-all-paths, 2026-09-26) — the
// confirmation-count + last-token-guard safety properties, tested in
// isolation. This is the harder half of the fix: the pool right now has
// exactly ONE live Anthropic token, and the pre-fix4 policy benched on a
// single occurrence of this exact error with no last-token check at all —
// which would have taken down every Claude-backed lane and the orchestrator
// itself on a transient blip (one was observed on a healthy account,
// 2026-09-24 22:48 acct2).
console.log('(e) fix4 safety properties: confirmation-count + last-token guard:');

// (e-a) a single occurrence never benches, even with only one token in the pool
{
  const entry = { id: 'only-token' };
  const calls = [];
  const logs = [];
  const result = handleSubscriptionDenial(
    { message: 'Your organization has disabled Claude subscription access' },
    entry, (t, ty) => calls.push([t, ty]), 0 /* zero OTHER live Anthropic tokens -- this IS the last one */, (m) => logs.push(m)
  );
  check('(e-a) single occurrence on the LAST live token → not benched', () =>
    assert.equal(result.benched, false));
  check('(e-a) single occurrence → not even confirmed yet', () =>
    assert.equal(result.confirmed, false));
  check('(e-a) markDead never called on a single occurrence', () =>
    assert.deepEqual(calls, []));
  check('(e-a) no loud log on an UNCONFIRMED occurrence (nothing definitive to warn about yet)', () =>
    assert.deepEqual(logs, []));
}

// (e-b) two consecutive occurrences on a token DO bench when other live
// Anthropic tokens exist
{
  const entry = { id: 'acct-with-a-backup' };
  const calls = [];
  const err = { message: 'Your organization has disabled Claude subscription access' };
  handleSubscriptionDenial(err, entry, (t, ty) => calls.push([t, ty]), 2 /* two other live tokens */, () => {});
  const second = handleSubscriptionDenial(err, entry, (t, ty) => calls.push([t, ty]), 2, () => {});
  check('(e-b) 2nd consecutive occurrence with other live tokens present → confirmed', () =>
    assert.equal(second.confirmed, true));
  check('(e-b) 2nd consecutive occurrence with other live tokens present → BENCHED', () =>
    assert.equal(second.benched, true));
  check('(e-b) markDead called exactly once, with deadType "auth"', () =>
    assert.deepEqual(calls, [[entry, 'auth']]));
}

// (e-c) two consecutive occurrences on the LAST live Anthropic token do NOT
// bench it -- logs loudly instead and the token stays available
{
  const entry = { id: 'acct2-yourname', dead: false }; // mirrors the real, single live pool token
  const calls = [];
  const logs = [];
  const err = { message: 'Your organization has disabled Claude subscription access' };
  const markDead = (t, ty) => { calls.push([t, ty]); t.dead = true; }; // would poison the token if ever called
  const log = (m) => logs.push(m);
  const first = handleSubscriptionDenial(err, entry, markDead, 0, log);
  const second = handleSubscriptionDenial(err, entry, markDead, 0, log);
  check('(e-c) 1st occurrence → not confirmed', () => assert.equal(first.confirmed, false));
  check('(e-c) 1st occurrence → not benched', () => assert.equal(first.benched, false));
  check('(e-c) 2nd consecutive occurrence on the LAST live token → confirmed', () =>
    assert.equal(second.confirmed, true));
  check('(e-c) 2nd consecutive occurrence on the LAST live token → NOT benched (spared)', () =>
    assert.equal(second.benched, false));
  check('(e-c) markDead is NEVER called for the last live token', () =>
    assert.deepEqual(calls, []));
  check('(e-c) the token itself is untouched -- still dead:false, still available', () =>
    assert.equal(entry.dead, false));
  check('(e-c) a loud warning was logged (this must never fail silently)', () => {
    assert.equal(logs.length, 1);
    assert.match(logs[0], /CONFIRMED/);
    assert.match(logs[0], /LAST live Anthropic token/);
    assert.match(logs[0], new RegExp(entry.id));
  });
}

// (e-d) a success (or a different, non-matching error) in between resets the
// consecutive counter back to needing 2 fresh confirmations
{
  const entry = { id: 'acct-flaps' };
  const err = { message: 'Your organization has disabled Claude subscription access' };
  const noop = () => {};
  const r1 = handleSubscriptionDenial(err, entry, noop, 3, noop);
  check('(e-d) 1st occurrence → not confirmed', () => assert.equal(r1.confirmed, false));
  // A different, non-matching error resets the counter (e.g. the very
  // transient-timeout blip that motivated this whole fix in the first place).
  const rReset = handleSubscriptionDenial({ message: 'request timeout' }, entry, noop, 3, noop);
  check('(e-d) a non-matching error is reported as not-a-subscription-denial', () =>
    assert.equal(rReset.isSubscriptionDenial, false));
  check('(e-d) ...and it reset the consecutive counter', () =>
    assert.equal(entry._consecutiveSubscriptionDenials, 0));
  const r2 = handleSubscriptionDenial(err, entry, noop, 3, noop);
  check('(e-d) next denial after the reset → back to square one (needs 2 FRESH confirmations, not confirmed yet)', () =>
    assert.equal(r2.confirmed, false));
  const r3 = handleSubscriptionDenial(err, entry, noop, 3, noop);
  check('(e-d) ...and only confirms on the 2nd FRESH consecutive occurrence', () =>
    assert.equal(r3.confirmed, true));

  // resetSubscriptionDenials / recordSubscriptionDenial exposed directly too,
  // exercised the same way resetAuthFailures/recordAuthFailure are above.
  const entry2 = {};
  recordSubscriptionDenial(entry2); // 1/2
  resetSubscriptionDenials(entry2); // explicit reset, e.g. on any success
  check('(e-d) resetSubscriptionDenials zeroes the counter directly', () =>
    assert.equal(entry2._consecutiveSubscriptionDenials, 0));
  check('(e-d) SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD === 2', () =>
    assert.equal(SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD, 2));
}

// REAL-GUARD PROOF for fix4 — distinguishes the OLD (fbb8f93) broken policy
// from the NEW one, the same way the AUTH_FAIL_THRESHOLD guard above does.
// Under the OLD policy, a SINGLE occurrence on the pool's only live Anthropic
// token was benched immediately, with zero confirmation and zero last-token
// check -- exactly the live 2026-09-24 22:48 (acct2) near-miss this WO exists
// to close.
console.log('(guard) OLD fix4 policy (bench on 1st occurrence, no last-token check) is gone:');
{
  const entry = { id: 'acct2-yourname' };
  const calls = [];
  const oldWouldBench = (err) => !!(err?.message || '').toLowerCase().includes('organization has disabled claude subscription access');
  // Reproduce the exact OLD call shape: bench unconditionally on match.
  const oldPolicyBenches = oldWouldBench({ message: 'Your organization has disabled Claude subscription access' });
  check('OLD policy: message matches → would have benched on the very first occurrence (bug reproduced)', () =>
    assert.equal(oldPolicyBenches, true));
  // And confirm the NEW function does NOT bench that same first occurrence,
  // even naming the real single-token pool's real token id.
  const newResult = handleSubscriptionDenial(
    { message: 'Your organization has disabled Claude subscription access' },
    entry, (t, ty) => calls.push([t, ty]), 0, () => {}
  );
  check('NEW policy: same first occurrence on the last live token → NOT benched (bug fixed)', () => {
    assert.equal(newResult.benched, false);
    assert.deepEqual(calls, []);
  });
}

console.log('\nALL PASS');
process.exit(0);

// auth-policy.js — SubStation token auth/bench policy (extracted for testability)
//
// Root cause this module fixes (2026-07-11): a single transient 401/403 from
// Anthropic's edge was benching the sole valid OAuth token for 24h, causing the
// daily "No Anthropic OAuth tokens found" outage. See handoff_substation_oauth_*.
//
// Three fixes live here:
//   1. AUTH_FAIL_THRESHOLD — require N *consecutive* auth failures before benching.
//   2. AUTH_DEAD_REVIVE_MS  — 24h -> 5min, so even a real bench self-heals fast.
//   (Fix 3, live-credentials re-read, lives in index.js getAnthropicOAuthTokens.)
//
// Fix 4 (2026-09-26, WO-flex-substation-fix4-bench-all-paths): the definitive
// org-disabled-subscription denial handling below was originally wired into
// exactly one Anthropic path (invokeClaudeSDKWithTools) and, on that one path,
// benched on a SINGLE occurrence — no confirmation, and no check for whether
// the token being benched was the pool's only live Anthropic token. Evidence
// showed the identical error string surface briefly on an otherwise-healthy
// account (2026-09-24 22:48, acct2) — i.e. it is not always a true, permanent
// denial. `handleSubscriptionDenial` below now:
//   (a) requires TWO CONSECUTIVE occurrences on the SAME token entry before
//       treating it as confirmed/definitive (mirrors recordAuthFailure /
//       AUTH_FAIL_THRESHOLD's "consecutive count on an entry" pattern, but
//       with its own dedicated counter — this signal is narrower and more
//       consequential than the generic 401/403 bucket), and
//   (b) never actually benches a confirmed denial if doing so would leave
//       zero live Anthropic tokens in the pool — it logs loudly via the
//       caller-supplied `log` and leaves the token alive instead.
// All four Anthropic invoke paths (invokeClaudeSDKWithTools, invokeClaudeSDK,
// invokeClaudeDirect, invokeClaudeMessagesAPIWithTools) now call this same
// function. `invokeCodex` is NOT an Anthropic path and does not call it.

export const DEAD_REVIVE_MS = 30 * 60 * 1000;        // 30 min — rate-limited tokens
export const AUTH_DEAD_REVIVE_MS = 5 * 60 * 1000;    // 5 min  — auth-failed tokens (was 24h)
export const AUTH_FAIL_THRESHOLD = 3;                // consecutive auth failures before benching
export const SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD = 2; // consecutive denials on ONE token before it's confirmed/definitive

// This response is an account-level denial, not a transient edge 401/403.
// Every Anthropic path should eventually stop choosing that account — but
// only once CONFIRMED (see handleSubscriptionDenial below); a single
// occurrence of this exact message has been observed on a healthy account.
export function isDisabledSubscriptionError(err) {
  return (err?.message || '').toLowerCase().includes('organization has disabled claude subscription access');
}

// Record a consecutive subscription-denial occurrence on the pool entry.
// Returns true ONLY once the entry has hit SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD
// consecutive occurrences — i.e. a CONFIRMED, definitive denial. A single
// occurrence (count < threshold) returns false, mirroring recordAuthFailure's
// "stays in service on a blip" semantics for this narrower, more consequential
// signal.
export function recordSubscriptionDenial(entry, threshold = SUBSCRIPTION_DENIAL_CONFIRM_THRESHOLD) {
  entry._consecutiveSubscriptionDenials = (entry._consecutiveSubscriptionDenials || 0) + 1;
  return entry._consecutiveSubscriptionDenials >= threshold;
}

// Reset the consecutive-subscription-denial counter. Call on any success on
// this entry, or any error on this entry that is NOT itself a subscription
// denial — mirrors resetAuthFailures' semantics for the broader auth bucket.
export function resetSubscriptionDenials(entry) {
  entry._consecutiveSubscriptionDenials = 0;
}

// Apply the definitive-denial policy for an Anthropic invoke request, on
// WHICHEVER of the four Anthropic paths is calling. Pool-agnostic/testable
// without a server: the caller supplies its own pool mutation (`markDead`),
// a plain count of the OTHER live Anthropic tokens in its pool right now (not
// counting `entry` — computed by the caller, which already has pool/token-list
// access; this file deliberately imports no pool/global state of its own),
// and its own `log` function (optional — omit it and this simply skips the
// loud-log side effect, it never throws for a missing logger).
//
// Returns a small descriptor rather than a bare boolean because a matched
// error needs different caller-side bookkeeping depending on the outcome:
//   { isSubscriptionDenial: false, confirmed: false, benched: false }
//     — not this error at all. The entry's consecutive-denial counter was
//       reset. The caller should treat this exactly as before (fall through
//       to its normal error classification for this error).
//   { isSubscriptionDenial: true, confirmed: false, benched: false }
//     — 1st occurrence on this entry. NOT benched — a single occurrence must
//       never bench, even if this is the pool's only live Anthropic token.
//   { isSubscriptionDenial: true, confirmed: true, benched: true }
//     — 2nd+ consecutive occurrence, and other live Anthropic tokens exist —
//       `markDead(entry, 'auth')` was called (bookkeeping, incl.
//       activeRequests, already handled by markDead).
//   { isSubscriptionDenial: true, confirmed: true, benched: false }
//     — 2nd+ consecutive occurrence, but `entry` is the pool's LAST live
//       Anthropic token. `markDead` was deliberately NOT called — the token
//       stays alive (dead: false) and available for the next request. A loud
//       warning was logged via `log` (if supplied) so this never fails
//       silently.
//
// In every case where isSubscriptionDenial is true, the caller should treat
// this attempt as over for this token (skip any further/generic auth-error
// branch for this same error — that generic branch would otherwise bench on
// a single occurrence, reintroducing exactly the risk this function exists to
// close) and, whenever `benched` is false, still perform its own normal
// end-of-attempt bookkeeping (e.g. markRequestEnd) since markDead was NOT
// called and therefore never decremented the entry's activeRequests count.
export function handleSubscriptionDenial(err, entry, markDead, otherLiveAnthropicTokenCount, log) {
  if (!isDisabledSubscriptionError(err)) {
    resetSubscriptionDenials(entry);
    return { isSubscriptionDenial: false, confirmed: false, benched: false };
  }
  const confirmed = recordSubscriptionDenial(entry);
  if (!confirmed) {
    return { isSubscriptionDenial: true, confirmed: false, benched: false };
  }
  if (otherLiveAnthropicTokenCount > 0) {
    markDead(entry, 'auth');
    return { isSubscriptionDenial: true, confirmed: true, benched: true };
  }
  if (typeof log === 'function') {
    log(`Token ${entry.id} hit a CONFIRMED (2x consecutive) "organization has disabled Claude subscription access" denial but is the pool's LAST live Anthropic token — refusing to bench it (would leave zero live Anthropic tokens for every Claude-backed lane and the orchestrator itself). Leaving it in rotation; investigate this account manually. If this repeats, it may be a genuine permanent org-level denial that needs a second Anthropic token added to the pool before it can safely be benched.`);
  }
  return { isSubscriptionDenial: true, confirmed: true, benched: false };
}

// Classify auth failures, including a definitive subscription-access denial.
export function isAuthError(err) {
  const msg = (err.message || '').toLowerCase();
  return isDisabledSubscriptionError(err) ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('unauthenticated') ||
    msg.includes('authentication') ||
    msg.includes('invalid token') ||
    msg.includes('token expired') ||
    msg.includes('not logged in') ||
    msg.includes('please log in') ||
    msg.includes('sign in') ||
    msg.includes('invalid_grant') ||
    msg.includes('invalid credentials') ||
    msg.includes('organization does not have access') ||
    msg.includes('contact your administrator') ||
    msg.includes('please login again') ||
    (err.statusCode === 401) ||
    (err.statusCode === 403);
}

// Record a consecutive auth failure on the pool entry. Returns true ONLY when the
// entry has now hit the threshold and should actually be benched. A single blip
// (count < threshold) returns false — the token stays in service.
export function recordAuthFailure(entry, threshold = AUTH_FAIL_THRESHOLD) {
  entry._consecutiveAuthFails = (entry._consecutiveAuthFails || 0) + 1;
  return entry._consecutiveAuthFails >= threshold;
}

// Reset the consecutive-auth-failure counter (call on any success).
export function resetAuthFailures(entry) {
  entry._consecutiveAuthFails = 0;
}

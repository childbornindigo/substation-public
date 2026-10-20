import { cappedSdkQuery } from './sdk-process-cap.js';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, existsSync, watch } from 'node:fs';
import {
  normalizeReasoningEffort,
  resolveRequestedReasoningEffort,
  resolveClaudeReasoningEffort,
  resolveCodexReasoningEffort,
} from './reasoning-effort.js';
import { SdkWarmRuntime, warmHash, probeLifecycleIdle, readWarmConfig } from './warm-cache-runtime.js';
import { isAuthError, handleSubscriptionDenial, resetSubscriptionDenials } from './auth-policy.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VERSION = '0.6.4';
const TIMEOUT = Number(process.env.SUBSTATION_CODEX_TIMEOUT_MS) || 540000; // Stay below Hermes' 600s idle watchdog.
const CODEX_ATTEMPT_TIMEOUT = Number(process.env.SUBSTATION_CODEX_ATTEMPT_TIMEOUT_MS) || 300000;
const CODEX_FIRST_BYTE_TIMEOUT = Number(process.env.SUBSTATION_CODEX_FIRST_BYTE_TIMEOUT_MS) || 30000;
const CODEX_PROGRESS_TIMEOUT = Number(process.env.SUBSTATION_CODEX_PROGRESS_TIMEOUT_MS) || 90000;
const CODEX_MAX_TOKEN_ATTEMPTS = Number(process.env.SUBSTATION_CODEX_MAX_TOKEN_ATTEMPTS) || 2;
const CODEX_IDENTICAL_FAILURE_COOLDOWN = Number(process.env.SUBSTATION_CODEX_IDENTICAL_FAILURE_COOLDOWN_MS) || 600000;
const codexRequestFailureCache = new Map();

// Operator system prompt — replaces Claude Code's default system prompt
const OPERATOR_SYSTEM_PROMPT = `You are an AI assistant powered by SubStation.
You are NOT Claude Code. You do not identify as Claude Code or as "Claude, an AI assistant by Anthropic."
Your operator has configured you through SubStation with their own identity and instructions.
Follow the system instructions provided in each conversation. Use tools when needed.

## Execution discipline — MANDATORY

These rules are enforced at the infrastructure level. Violations waste budget and will be flagged.

1. TOOL CALLS FIRST. Every response that advances a task MUST contain at least one tool call. If you cannot make a tool call, state the specific blocker (error message, missing input, rate limit) — nothing else.
2. NEVER output "starting now", "I will do X", "about to", "doing it now", "I've been silent", or any status narration without a tool call in the same response. Intent is not progress. Only tool results are progress.
3. If you already said you would do something and have not done it, DO NOT repeat the promise. Either execute it (tool call) or state what is blocking you (specific error).
4. After recovering from an error or rate limit, your FIRST action must be a tool call — not an apology, not a status update, not a summary of what happened.
5. No summaries of work unless the work is verified complete with tool output as evidence. "Done" means you can point to the artifact.
6. If a task will take multiple turns, write your plan to a file BEFORE announcing it. The file is the proof you started.
7. If you are confused or stuck, say "BLOCKED: [reason]" and stop. Do not fill the gap with narration.
8. SKILL ROUTING IS A PER-TASK LOOP, NOT A ONCE-PER-TURN CALL. If a skill router is available (route_skill / mcp_skillrouter_route_skill), call it BEFORE each distinct task or sub-task with a description of what you're about to do, and follow the result: "auto" → load and follow that SKILL.md; "suggest" → mention/load it; "none" → only now is inline work licensed. When that task finishes, route AGAIN before starting the next distinct task. A turn with three distinct tasks = at least three route calls, one before each. A turn that changes topic/tool/target mid-way is multiple tasks — re-route at each boundary. If you catch yourself doing inline work without having routed for the current task, STOP and route first. This rule is identical for every model on this proxy — primary and failover, no exceptions.

ORCHESTRATOR DEFAULT = DISPATCH. Heavy work (grounding, multi-file search, builds, image regen, audits, scrapes) is a WORK ORDER sent to a Right Hand lane with ~/.hermes/workspace/scripts/rh.sh send <lane> "<task>", not ground through inline where it burns operator-paid usage. Before a third exploratory tool call on one sub-task, dispatch it unless the work is only reading a known file, one targeted search, or composing the WO.

9. USE THE TOOL NAMES IN THIS SESSION'S SCHEMA — THIS IS NOT CLAUDE CODE. Canonical names include terminal, read_file, search_files, patch, write_file, clarify, todo, skill_view, and delegate_task. A compatibility layer can recover common Claude-Code aliases, but relying on it hides mistakes; NotebookEdit has no equivalent and remains a hard error. Check the schema instead of guessing a capitalized name.

10. DO NOT NARRATE BEFORE A TOOL CALL. Never preface a tool call with "let me look", "let me check", "reading now", "I'll verify", or a restatement of the plan. Emit the tool call directly. Speak only AFTER you have the result — and only to deliver the answer or a verified status. One short sentence of framing is allowed only when NOT accompanied by any tool call (a pure question or final report). Thinking out loud between tool calls is the token-burn the operator is paying for; cut it.

11. YOU ARE THE PROMPT MASTER — HAND WORKERS REAL INPUTS, NEVER YOUR PARAPHRASE OF THEM. A worker's output is only as good as the input you give it. The #1 time-waster on this proxy is broken-telephone translation: the user gives a reference image / design-system doc / dieline / example, and instead of passing the ACTUAL ASSET to the worker or image model, you write a prose DESCRIPTION of it into the work order. The model then generates from your paraphrase and produces garbage — wrong labels, wrong layout, "not the reference." This is YOUR failure, not the worker's. RULES: (a) When the user references an asset (image, mockup, dieline, design-system file, competitor page, reference render), the work order MUST carry that asset by real absolute file path passed as an actual input (input_image / attached file / verbatim template block), NOT a sentence describing what it looks like. (b) When a design-system, template, or spec file already exists on disk, quote it VERBATIM or point the worker at its exact path — never summarize it. (c) Before dispatching any WO that says "match/like/port the reference," verify the WO names the real source paths as inputs; if it only describes them in words, STOP and rewrite it. (d) Restating the user's ask in your own softer words to the worker loses fidelity — carry their exact intent, exact constraints, exact asset paths. If the user gave you a file, the worker gets the file, not your book report on it.

12. TOOL RECORDS IN THE HISTORY ARE SYSTEM-WRITTEN, NEVER YOURS TO TYPE. Earlier tool activity in this conversation is replayed as bracketed history records labelled tool_call and tool_result, each with an id and a name. They are read-only history, not an output format. Never write a tool call or a tool result as text, and never state a tool result you did not actually receive in this turn. To use a tool, make a real tool call; if you cannot, say BLOCKED with the specific reason. A reply that contains typed-out tool calls is discarded by the caller.`;
const HERMES_RUNTIME_PROMPT = `\n\n## Hermes runtime contract\n\nYou are running inside Hermes through SubStation, not inside your native Codex/Claude desktop. Treat the request's tool schema as the whole truth. Do not invent unavailable functions, capitalized aliases, notebook tools, browser tools, MCP tools, or Agent tools unless they are explicitly present in the schema for this request. If a desired tool is absent, use the closest available tool from the schema or state the exact missing capability as BLOCKED.`;
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB request body limit
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB log rotation
const DEAD_REVIVE_MS = 30 * 60 * 1000;       // 30 min — auto-retry rate-limited tokens
const AUTH_DEAD_REVIVE_MS = 5 * 60 * 1000; // 5 min — retry auth/session failures soon on single-account setups
const DATA_DIR = join(homedir(), '.substation', 'data');
const PORT = parseInt(process.env.SUBSTATION_PORT || '8403');
const AUTH_KEY = process.env.SUBSTATION_API_KEY || 'sk-substation-local-proxy';

const POOL_FILE = join(homedir(), '.substation', 'token-pool.json');
const POOL_STATE_FILE = join(homedir(), '.substation', 'pool-state.json');
const AUTH_PROFILES_PATH = process.env.SUBSTATION_AUTH_PROFILES || join(homedir(), '.claude', 'auth-profiles.json');
const LOG_PATH = join(homedir(), '.substation', 'substation.log');

// Ensure dirs
try { mkdirSync(join(homedir(), '.substation'), { recursive: true }); } catch {}
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Neutral working directory for native SDK (Claude Code CLI) queries.  The CLI child
// otherwise inherits this process' cwd, and for that cwd it prepends the repo's
// `gitStatus` (branch, working-tree status, last 5 commits) and the project's
// auto-memory MEMORY.md ahead of the cached conversation blocks.  Any commit, edit
// or memory write by another lane in the checkout then rewrote the cached prefix of
// every live session (cache-cliff WO 2026-10-06, cause C3).  Callers' tools are
// captured, never executed by the CLI, so its cwd carries no function.
const SDK_NEUTRAL_CWD = join(homedir(), '.substation', 'sdk-cwd');
try { mkdirSync(SDK_NEUTRAL_CWD, { recursive: true }); } catch {}

// OPT-IN (SUBSTATION_SDK_CONFIG_ISOLATION=1), cache-cliff WO 2026-10-06, cause C6.
// The CLI chooses parts of its system prompt from GrowthBook flags cached in the
// global ~/.claude.json.  The two pool accounts get different flag payloads and
// every CLI process (SubStation's and any interactive Claude Code session) rewrites
// that one file, so a request can start with the other account's flags and send a
// different system prompt than the cached one (62 of 255 cliffs, 10.6M cache-write
// tokens in 1.3 days).  A per-account config dir keeps each account's flags to itself.  Off by default: whether the
// OAuth-token path still gets 1h cache TTL in a fresh config dir can only be proven
// live, so enable it with a canary (see deploy notes).
// Keys NOT copied into a new per-account config: project/user specific or bulky.
// Everything else (onboarding state, ids, the current flag cache incl. cache-TTL
// eligibility) is copied so the first request in a fresh dir behaves like today.
const SDK_CONFIG_SEED_DENY = new Set(['projects', 'mcpServers', 'githubRepoPaths', 'skillUsage', 'tipsHistory', 'pluginUsage', 'feedbackSurveyState', 'seenNotifications']);
function sdkConfigDirForToken(token) {
  if (process.env.SUBSTATION_SDK_CONFIG_ISOLATION !== '1') return null;
  try {
    const dir = join(homedir(), '.substation', 'sdk-config', String(token?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.claude.json');
    if (!existsSync(file)) {
      let seed = {};
      try {
        const global = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
        for (const [key, value] of Object.entries(global)) if (!SDK_CONFIG_SEED_DENY.has(key)) seed[key] = value;
      } catch {}
      writeFileSync(file, JSON.stringify(seed), { mode: 0o600 });
    }
    return dir;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Logging (with rotation)
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] [SubStation] ${msg}`;
  // Under the real deployment, launchd's StandardOutPath points stdout at
  // this exact same LOG_PATH file, so console.log() and the writeFileSync
  // below would both land in it -- every line would appear twice, and log
  // rotation below would only affect the writeFileSync path (stdout keeps
  // its original fd pointed at the now-renamed .old file). When stdout is
  // not a TTY (piped/redirected to a file, as launchd does), skip
  // console.log entirely and let writeFileSync be the single write path.
  // Interactive/dev usage (a real TTY) keeps seeing console.log as before.
  if (process.stdout.isTTY) {
    console.log(line);
  }
  try {
    // Rotate log if too large
    try {
      const stats = statSync(LOG_PATH);
      if (stats.size > LOG_MAX_SIZE) {
        try { renameSync(LOG_PATH, LOG_PATH + '.old'); } catch {}
      }
    } catch {}
    writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
  } catch {}
}

// ---------------------------------------------------------------------------
// Global error handlers — prevent crashes from taking down the host process
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION (non-fatal): ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION (non-fatal): ${reason}`);
});

// ---------------------------------------------------------------------------
// Deploy status / stale-code detection (2026-09-25 WO fix3)
//
// Incident: commit 1609bd8 (fixing "commands run twice") landed
// 2026-09-24 00:35, but the live process (PID 76155, started
// 2026-09-22 22:16) kept serving the OLD pre-fix code for ~43 hours with
// nothing anywhere reporting the mismatch. This section makes that
// mismatch visible (detection only -- no auto-restart): it records the git
// commit and dist/index.js hash this process loaded at startup, then
// re-hashes dist/index.js on every /health and /pool request so a stale
// running process reports staleCode: true instead of silently serving old
// code.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DIST_INDEX_PATH = join(REPO_ROOT, 'dist', 'index.js');

function computeRunningCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    log(`WARN: could not determine git HEAD commit for deploy status: ${err.message}`);
    return 'unknown';
  }
}

function hashDistFile(distPath) {
  try {
    return createHash('sha256').update(readFileSync(distPath)).digest('hex');
  } catch (err) {
    log(`WARN: could not hash ${distPath} for deploy status: ${err.message}`);
    return null;
  }
}

// Computed once at module load -- this is "what actually got loaded into
// memory" for this running process, and never changes afterward.
const runningCommit = computeRunningCommit();
const loadedDistHash = hashDistFile(DIST_INDEX_PATH);
const startedAt = new Date().toISOString();

log(`Deploy status (commit=${runningCommit}, distHash=${loadedDistHash ? loadedDistHash.slice(0, 12) : 'unknown'}, startedAt=${startedAt})`);

// Returns fresh deploy status on every call by re-reading dist/index.js from
// disk right now -- deliberately NOT cached, since the whole point is
// detecting when the on-disk file has drifted from what this process
// loaded at startup. `testDeps.distPath` lets tests point this at a
// fixture file instead of the real, live dist/index.js (same testDeps
// override convention as invokeClaudeSDKWithTools).
function getDeployStatus(testDeps = {}) {
  const distPath = testDeps.distPath || DIST_INDEX_PATH;
  const currentDistHash = hashDistFile(distPath);
  return {
    runningCommit,
    loadedDistHash,
    startedAt,
    staleCode: currentDistHash !== null && currentDistHash !== loadedDistHash,
  };
}

// ---------------------------------------------------------------------------
// Model config — per-model limits and capabilities
// ---------------------------------------------------------------------------

const MODEL_CONFIG = {
  // Anthropic
  'claude-fable-5-1':          { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-opus-5-5':           { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-opus-5':             { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-sonnet-5-5':         { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-sonnet-5':           { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-fable-5':            { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-opus-4-8':           { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-opus-4-7':           { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-opus-4-6':           { maxTokens: 128000, adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-sonnet-4-6':         { maxTokens: 64000,  adaptive: true,  provider: 'anthropic', contextWindow: 1000000 },
  'claude-haiku-4-5-20251001': { maxTokens: 64000,  adaptive: false, provider: 'anthropic', contextWindow: 1000000 },
  // OpenAI (Codex) — ordered fastest to slowest
  'gpt-6-luna':         { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-6-luna', reasoningEffort: 'medium' },
  'gpt-6.1-sol':        { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 272000, apiModel: 'gpt-6.1-sol', reasoningEffort: 'low' },
  'gpt-6-sol':          { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-6-sol', reasoningEffort: 'max' },
  'gpt-6-astra':        { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-6-astra', reasoningEffort: 'high' },
  'gpt-5.4-mini':       { maxTokens: 64000,  adaptive: false, provider: 'openai', contextWindow: 400000 },
  'gpt-5.4':            { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 400000 },
  // ChatGPT Pro tier. GPT-5.6 Sol is the flagship GPT-5.6 model; Terra is
  // the faster balanced tier for orchestration and routine work. gpt-5.6
  // remains as an alias for callers that use the family-level name.
  'gpt-5.5':            { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 400000 },
  'gpt-5.6-terra':      { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-5.6-terra', reasoningEffort: 'medium' },
  'gpt-5.6-sol':        { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-5.6-sol', reasoningEffort: 'max' },
  'gpt-5.6':            { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-5.6-sol', reasoningEffort: 'max' },
  'gpt-5.6-sol-pro':    { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-5.6-sol', reasoningEffort: 'max' },
  'gpt-5.6-pro':        { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 1050000, apiModel: 'gpt-5.6-sol', reasoningEffort: 'max' },
  'gpt-5.3-codex':      { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 400000, apiModel: 'gpt-5.3-codex', reasoningEffort: 'high' },
  'gpt-5.1-codex':      { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 400000 },
  'gpt-5.1-codex-mini': { maxTokens: 64000,  adaptive: false, provider: 'openai', contextWindow: 128000 },
  'gpt-5.1-codex-max':  { maxTokens: 128000, adaptive: false, provider: 'openai', contextWindow: 400000 },
};

const MODEL_MAP = {
  // Anthropic aliases
  'fable-5-1': 'claude-fable-5-1',
  'fable-5.1': 'claude-fable-5-1',
  'claude-fable-5-1': 'claude-fable-5-1',
  'opus-5-5': 'claude-opus-5-5',
  'opus-5.5': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-opus-5-5',
  'opus-5': 'claude-opus-5',
  'claude-opus-5': 'claude-opus-5',
  'sonnet-5-5': 'claude-sonnet-5-5',
  'sonnet-5.5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
  'sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'fable-5': 'claude-fable-5',
  'fable': 'claude-fable-5-1',
  'claude-fable-5': 'claude-fable-5',
  'opus-4-8': 'claude-opus-4-8',
  'claude-opus-4-8': 'claude-opus-4-8',
  'opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
  // OpenAI aliases
  'gpt-6-luna': 'gpt-6-luna',
  'luna': 'gpt-6-luna',
  'gpt-6.1-sol': 'gpt-6.1-sol',
  'gpt-6-sol': 'gpt-6-sol',
  'gpt-6': 'gpt-6-sol',
  'gpt-latest': 'gpt-6-sol',
  'gpt-6-astra': 'gpt-6-astra',
  'astra': 'gpt-6-astra',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'terra': 'gpt-5.6-terra',
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5.6-sol-pro': 'gpt-5.6-sol-pro',
  'gpt-5.6-pro': 'gpt-5.6-pro',
  'sol': 'gpt-5.6-sol',
  'sol-pro': 'gpt-5.6-sol-pro',
  'pro': 'gpt-5.6-sol-pro',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'codex-latest': 'gpt-5.3-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  'gpt-5.1-codex': 'gpt-5.1-codex',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'codex-max': 'gpt-5.1-codex-max',
  'codex': 'gpt-5.1-codex',
  'codex-mini': 'gpt-5.1-codex-mini',
};

// ---------------------------------------------------------------------------
// Narration loop breaker — mechanical enforcement against apology loops
// ---------------------------------------------------------------------------

const NARRATION_PATTERNS = /\b(starting now|i will|i'll|about to|doing it now|i've been silent|apologies for|sorry for the|let me now|going to|working on it|i'm going to|right away|immediately|try(?:ing)? again|re-?run(?:ning)?|retry(?:ing)?)\b/i;
const MAX_CONSECUTIVE_NARRATIONS = 2;
const narrationCounters = new Map(); // sessionKey → count
const progressTracker = new Map(); // sessionKey → { lastCallHash, lastResultHash, tailHash, repeat }
const sdkResumeCache = new Map(); // sessionKey → { sdkSessionId, token, model, messageCount, prefixHash }

function isNarrationOnly(text) {
  if (!text || text.length < 10) return false;
  if (text.length > 2000) return false; // long responses are likely real work
  return NARRATION_PATTERNS.test(text);
}

function trackNarration(sessionKey, hadToolUse, text, noProgress = false) {
  if (hadToolUse && !noProgress) {
    narrationCounters.set(sessionKey, 0);
    return false;
  }
  if (noProgress || isNarrationOnly(text)) {
    const count = (narrationCounters.get(sessionKey) || 0) + 1;
    narrationCounters.set(sessionKey, count);
    log(`Narration loop detector: ${sessionKey} — ${count}/${MAX_CONSECUTIVE_NARRATIONS} consecutive narrations`);
    if (count >= MAX_CONSECUTIVE_NARRATIONS) {
      narrationCounters.set(sessionKey, 0);
      return true; // trigger circuit breaker
    }
  } else {
    narrationCounters.set(sessionKey, 0);
  }
  return false;
}

function stableToolArgs(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs || {};
  try { return JSON.parse(rawArgs); } catch { return rawArgs; }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(block => block?.text ?? block?.content ?? JSON.stringify(block)).join('\n');
}

function progressSessionKey(messages, model) {
  const seed = (messages || []).find(message => message.role === 'user')
    || (messages || []).find(message => message.role === 'system' || message.role === 'developer');
  return createHash('sha1').update(`${model}\0${seed?.role || ''}\0${textContent(seed?.content)}`).digest('hex');
}

// Byte-identity check over the first `count` messages -- used to verify a
// cached Agent SDK session's known prefix hasn't drifted (edited, summarized
// away by Hermes's own compaction, reordered) before trusting `resume` to
// skip resending it. Any mismatch here means "don't resume, fall back to the
// full prompt" -- never guess.
function hashMessagesPrefix(messages, count) {
  const h = createHash('sha1');
  for (let i = 0; i < count; i++) {
    const m = messages[i] || {};
    h.update(m.role || '');
    h.update('\0');
    h.update(textContent(m.content));
    h.update('\0');
    if (m.tool_calls) h.update(JSON.stringify(m.tool_calls));
    h.update('\0');
    if (m.tool_call_id) h.update(m.tool_call_id);
    h.update('');
  }
  return h.digest('hex');
}

function latestToolProgress(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const result = messages[i];
    if (result.role !== 'tool' && result.role !== 'function') continue;
    const callId = result.tool_call_id;
    for (let j = i - 1; j >= 0; j--) {
      const calls = messages[j].tool_calls;
      if (!Array.isArray(calls)) continue;
      const call = calls.find(candidate => !callId || candidate.id === callId);
      if (!call) continue;
      const toolName = call.function?.name || call.name || result.name || 'tool';
      const normalizedArgs = stableToolArgs(call.function?.arguments ?? call.arguments);
      const tail = createHash('sha1');
      for (let k = i + 1; k < (messages || []).length; k++) {
        const message = messages[k] || {};
        tail.update(message.role || '');
        tail.update('\0');
        tail.update(textContent(message.content));
        tail.update('\0');
        if (message.tool_calls) tail.update(JSON.stringify(message.tool_calls));
        tail.update('\0');
      }
      return {
        toolName,
        callHash: createHash('sha1').update(toolName + JSON.stringify(normalizedArgs)).digest('hex'),
        resultHash: createHash('sha1').update(textContent(result.content)).digest('hex'),
        tailHash: tail.digest('hex'),
      };
    }
  }
  return null;
}

function enforceToolProgress(messages, model) {
  const progress = latestToolProgress(messages);
  if (!progress) return false;
  const sessionKey = progressSessionKey(messages, model);
  const previous = progressTracker.get(sessionKey);
  const repeat = previous
    && previous.lastCallHash === progress.callHash
    && previous.lastResultHash === progress.resultHash
    && previous.tailHash === progress.tailHash
    ? previous.repeat + 1
    : 0;
  progressTracker.set(sessionKey, { lastCallHash: progress.callHash, lastResultHash: progress.resultHash, tailHash: progress.tailHash, repeat });
  const noProgress = repeat >= 1;
  if (noProgress) trackNarration(sessionKey, false, '', true);
  const maxRepeats = progress.toolName === 'execute_code' ? 4 : 2;
  if (repeat >= maxRepeats) {
    // Reset tracked state before throwing. Without this, `repeat` never
    // comes back down — every future request for this sessionKey still has
    // the same stale tail tool_call/result (a client-side corrective notice
    // is a user-role message, invisible to latestToolProgress), so it keeps
    // matching `previous` and re-throws forever, permanently deadlocking the
    // conversation even after the caller reacts to the error.
    progressTracker.delete(sessionKey);
    throw new Error(`BLOCKED: repeated identical tool call with no state change (${progress.toolName}). Change approach — do not re-run the same call.`);
  }
  return noProgress;
}

function resolveModel(model) {
  const clean = model.includes('/') ? model.split('/').pop() : model;
  const resolved = MODEL_MAP[clean];
  if (resolved) return { modelId: resolved, ...(MODEL_CONFIG[resolved] || { maxTokens: 64000, adaptive: false, provider: 'anthropic', contextWindow: 1000000 }) };
  return { modelId: 'claude-sonnet-4-6', ...MODEL_CONFIG['claude-sonnet-4-6'] };
}

// ---------------------------------------------------------------------------
// Agent SDK — persistent Claude sessions with multi-token LRU rotation
// ---------------------------------------------------------------------------

let agentSDK = null;
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 min idle → close session

async function loadAgentSDK() {
  if (!agentSDK) {
    try {
      agentSDK = await import('@anthropic-ai/claude-agent-sdk');
      log('Agent SDK loaded successfully');
    } catch (e) {
      log(`WARN: Agent SDK not available (${e.message}) — install: npm install @anthropic-ai/claude-agent-sdk`);
      throw new Error('Agent SDK not installed. Install it with: npm install @anthropic-ai/claude-agent-sdk');
    }
  }
  return agentSDK;
}

// Collect Anthropic OAuth tokens for SDK rotation
function getAnthropicOAuthTokens() {
  const tokens = pool.filter(t => t.provider === 'anthropic' && !t.dead);
  if (tokens.length === 0) {
    // Fallback: check auth-profiles directly
    try {
      const ap = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
      const oauthTokens = Object.entries(ap.profiles || {})
        .filter(([id, p]) => id.startsWith('anthropic:') && p.token)
        .map(([id, p]) => ({ id: `ap:${id}`, token: p.token }));
      return oauthTokens;
    } catch { return []; }
  }
  // Return real pool references (not stripped copies) — callers (invokeClaudeSDK,
  // invokeClaudeMessagesAPIWithTools) mutate .cooldownUntil/.errorCount on these
  // objects via markRateLimited/markSuccess, and that state must persist across
  // requests. A stripped {id, token} copy silently discarded every cooldown/backoff
  // write, so Anthropic tokens never actually got throttled between requests.
  return tokens;
}

// Legacy constants kept for fallback direct API path
const ANTHROPIC_BETA_HEADERS = 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20';
const CLAUDE_CODE_SYSTEM_PREFIX = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

// ---------------------------------------------------------------------------
// Token Pool Manager
// ---------------------------------------------------------------------------

let pool = [];

function loadTokenPool() {
  const seen = new Set();
  const tokens = [];

  function addToken(id, provider, token, refreshToken) {
    if (!token || seen.has(token)) return;
    // Basic token format validation
    if (provider === 'anthropic' && !token.startsWith('sk-ant-')) {
      log(`WARN: Token ${id} doesn't look like an Anthropic OAuth token (expected sk-ant-oat...), skipping`);
      return;
    }
    seen.add(token);
    tokens.push({
      id,
      provider,
      token,
      refreshToken: refreshToken || null,
      lastUsed: 0,
      lastSuccess: 0,
      cooldownUntil: null,
      errorCount: 0,
      requestCount: 0,
      dead: false,
      deadSince: null,
      activeRequests: 0,
    });
  }

  // Source 1: token-pool.json
  try {
    const data = JSON.parse(readFileSync(POOL_FILE, 'utf8'));
    for (const t of (data.tokens || [])) {
      if (!t.token) {
        log(`WARN: Token entry "${t.id || '?'}" in token-pool.json has no token value, skipping`);
        continue;
      }
      addToken(t.id || `pool:${tokens.length}`, t.provider || 'anthropic', t.token, t.refreshToken);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARN: Failed to read ${POOL_FILE}: ${e.message}`);
  }

  // Source 2: auth-profiles.json — main agent (anthropic tokens only)
  try {
    const ap = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
    for (const [pid, profile] of Object.entries(ap.profiles || {})) {
      if (pid.startsWith('anthropic:') && profile.token && profile.token.startsWith('sk-ant-oat')) {
        addToken(`ap:${pid}`, 'anthropic', profile.token);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARN: Failed to read auth-profiles.json: ${e.message}`);
  }

  // Source 2b: secondary agent auth-profiles (backup OAuth tokens)
  const SECONDARY_AUTH = process.env.SUBSTATION_SECONDARY_AUTH_PROFILES;
  if (SECONDARY_AUTH) {
    try {
      const sa = JSON.parse(readFileSync(SECONDARY_AUTH, 'utf8'));
      for (const [pid, profile] of Object.entries(sa.profiles || {})) {
        if (pid.startsWith('anthropic:') && profile.token && profile.token.startsWith('sk-ant-oat')) {
          addToken(`backup:${pid}`, 'anthropic', profile.token);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log(`WARN: Failed to read secondary auth-profiles: ${e.message}`);
    }
  }

  // Source 3: env var (anthropic)
  if (process.env.SUBSTATION_OAUTH_TOKENS) {
    process.env.SUBSTATION_OAUTH_TOKENS.split(',').forEach((t, i) => {
      const trimmed = t.trim();
      if (trimmed) addToken(`env:${i}`, 'anthropic', trimmed);
    });
  }

  // Source 4: single token env vars (backward compat)
  if (process.env.SUBSTATION_OAUTH_TOKEN) {
    addToken('env:single', 'anthropic', process.env.SUBSTATION_OAUTH_TOKEN);
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    addToken('env:hermes', 'anthropic', process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  return tokens;
}

function loadPoolState() {
  try {
    const state = JSON.parse(readFileSync(POOL_STATE_FILE, 'utf8'));
    const stateMap = {};
    for (const s of (state.entries || [])) stateMap[s.id] = s;
    for (const entry of pool) {
      const s = stateMap[entry.id];
      if (s) {
        entry.lastUsed = s.lastUsed || 0;
        entry.lastSuccess = s.lastSuccess || 0;
        entry.cooldownUntil = s.cooldownUntil || null;
        entry.errorCount = s.errorCount || 0;
        entry.requestCount = s.requestCount || 0;
        entry.dead = s.dead || false;
        entry.deadSince = s.deadSince || null;
        entry.deadType = s.deadType || null;
        entry.usage = s.usage || null;
      }
    }
  } catch {}
}

let saveDebounceTimer = null;
function savePoolState() {
  if (saveDebounceTimer) return;
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    try {
      const data = JSON.stringify({
        updatedAt: new Date().toISOString(),
        entries: pool.map(t => ({
          id: t.id,
          provider: t.provider,
          lastUsed: t.lastUsed,
          lastSuccess: t.lastSuccess,
          cooldownUntil: t.cooldownUntil,
          errorCount: t.errorCount,
          requestCount: t.requestCount,
          dead: t.dead,
          deadSince: t.deadSince,
          deadType: t.deadType || null,
          usage: t.usage || null,
        })),
      }, null, 2);
      const tmp = POOL_STATE_FILE + '.tmp';
      writeFileSync(tmp, data);
      renameSync(tmp, POOL_STATE_FILE);
    } catch (e) {
      log(`Failed to save pool state: ${e.message}`);
    }
  }, 500);
}

function selectToken(provider) {
  const now = Date.now();
  const available = pool.filter(t =>
    t.provider === provider &&
    !t.dead &&
    (!t.cooldownUntil || t.cooldownUntil < now)
  );
  if (available.length === 0) return null;
  // LRU: least recently used first, prefer tokens with fewer active requests
  available.sort((a, b) => {
    if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
    return a.lastUsed - b.lastUsed;
  });
  return available[0];
}

function markSuccess(entry) {
  entry.lastUsed = Date.now();
  entry.lastSuccess = Date.now();
  entry.requestCount++;
  entry.errorCount = 0;
  entry._consecutive429s = 0; // reset backoff on success
  entry.activeRequests = Math.max(0, entry.activeRequests - 1);
  savePoolState();
}

// Captures Anthropic's `anthropic-ratelimit-unified-*` response headers off real
// traffic and stores them on the entry so the status server can report per-token
// usage. The dedicated GET /api/oauth/usage endpoint is hard-429'd (and needs a
// live-refreshed token + Claude-Code framing to answer at all), but these headers
// ride along free on every successful inference call. Fully guarded — a malformed
// header can never throw into the hot response path.
function recordUsageHeaders(entry, headers) {
  try {
    if (!entry || !headers) return;
    const get = (k) => headers['anthropic-ratelimit-unified-' + k];
    const toPct = (v) => {
      const n = parseFloat(v);
      if (isNaN(n)) return null;
      return n <= 1 ? n * 100 : n; // headers seen as 0..1 fraction; tolerate 0..100 too
    };
    const toIso = (v) => {
      const n = parseFloat(v);
      if (isNaN(n)) return null;
      const ms = n > 1e12 ? n : n * 1000; // epoch seconds (or ms) → ISO
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };
    const fiveHourPct = toPct(get('5h-utilization'));
    const sevenDayPct = toPct(get('7d-utilization'));
    if (fiveHourPct === null && sevenDayPct === null) return; // nothing to record
    entry.usage = {
      capturedAt: Date.now(),
      fiveHourPct,
      fiveHourReset: toIso(get('5h-reset')),
      sevenDayPct,
      sevenDayReset: toIso(get('7d-reset')),
      status: get('status') || null,
    };
    savePoolState();
  } catch { /* usage capture is best-effort; never disturb the response */ }
}

// Live traffic is served by the SDK subprocess path, which never exposes raw
// HTTP response headers — so recordUsageHeaders would otherwise never fire and
// each account's 5h/7d usage would stay blank. This keeps entry.usage fresh by
// making one tiny fully-framed max_tokens:1 call per active Anthropic account on
// an interval; makeAnthropicRequest's 200 branch captures the headers. Cheap,
// best-effort, and it skips any account already in cooldown.
const USAGE_PROBE_INTERVAL_MS = 3 * 60 * 1000;
function usageProbesDisabled() {
  // Preserve emergency containment independently of the SDK child cap.
  // An unreadable switch is not permission to make a maintenance request.
  try { statSync(join(homedir(), '.hermes', 'lane-memory', 'DISABLED')); return true; }
  catch (error) { return error?.code !== 'ENOENT'; }
}

async function probeUsageOnce() {
  if (usageProbesDisabled()) return;
  try {
    const tokens = getAnthropicOAuthTokens();
    const now = Date.now();
    for (const token of tokens) {
      if (usageProbesDisabled()) return;
      if (token.cooldownUntil && token.cooldownUntil > now) continue;
      const body = JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        system: CLAUDE_CODE_SYSTEM_PREFIX,
        messages: [{ role: 'user', content: 'ping' }],
      });
      try {
        await makeAnthropicRequest(body, token); // 200 branch records usage headers
      } catch (e) {
        // A cap here is real signal, not a probe artifact — cool the token down
        // exactly like live traffic would, so it isn't hammered.
        if (e && e.statusCode === 429) {
          const knownSecs = parseKnownResetSeconds(e.message);
          markRateLimited(token, knownSecs || parseInt(e.retryAfter || '60', 10), !!knownSecs);
        }
      }
    }
  } catch { /* never let the probe loop throw */ }
}
function startUsageProbeLoop() {
  if (usageProbesDisabled()) return;
  setTimeout(() => { probeUsageOnce(); }, 8000);
  setInterval(() => { probeUsageOnce(); }, USAGE_PROBE_INTERVAL_MS);
}

function markRateLimited(entry, retryAfterSec, isKnownCap = false) {
  // isKnownCap=true means retryAfterSec is an exact parsed reset time (e.g. a
  // Claude Max daily/session cap) — use it directly instead of the generic
  // exponential backoff, which was previously capping ALL cooldowns at 30min
  // and causing repeated doomed retries against a token that can't succeed
  // again until its real reset (sometimes hours away).
  let backoffSec;
  if (isKnownCap) {
    backoffSec = Math.max(retryAfterSec, 30);
    entry._consecutive429s = 0;
  } else {
    // Exponential backoff: consecutive 429s double the cooldown (60s → 120s → 240s → 480s, cap 30min)
    const baseSec = retryAfterSec || 60;
    const recentErrors = entry._consecutive429s || 0;
    entry._consecutive429s = recentErrors + 1;
    backoffSec = Math.min(baseSec * Math.pow(2, recentErrors), 1800); // cap 30min
  }
  const cooldownMs = backoffSec * 1000;
  entry.cooldownUntil = Date.now() + cooldownMs;
  entry.lastUsed = Date.now();
  entry.errorCount++;
  entry.activeRequests = Math.max(0, entry.activeRequests - 1);
  savePoolState();
  log(`Token ${entry.id} rate-limited, cooldown ${backoffSec}s${isKnownCap ? ' (known cap, exact reset time)' : ` (attempt ${entry._consecutive429s})`}, until ${new Date(entry.cooldownUntil).toISOString()}`);
}

// Parses an exact reset time out of Anthropic/Claude-Code usage-cap error
// messages so a token can be cooled down for the REAL duration instead of a
// generic capped backoff. Handles both formats seen in practice:
//   "resets at 2026-07-19T11:00:00.000Z"       (ISO, ms path)
//   "You've hit your limit · resets 7am (America/Toronto)"  (SDK tool path)
// Returns seconds-until-reset, or null if no reset time could be parsed.
function parseKnownResetSeconds(message) {
  if (!message) return null;
  const isoMatch = message.match(/resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
  if (isoMatch) {
    const t = new Date(isoMatch[1]).getTime();
    if (!isNaN(t) && t > Date.now()) return Math.ceil((t - Date.now()) / 1000);
  }
  const localMatch = message.match(/resets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([\w/]+)\)/i);
  if (localMatch) {
    try {
      let [, hh, mm, ap, tz] = localMatch;
      hh = parseInt(hh, 10) % 12;
      if (/pm/i.test(ap)) hh += 12;
      mm = mm ? parseInt(mm, 10) : 0;
      const now = new Date();
      const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const dp = Object.fromEntries(dateFmt.formatToParts(now).map(p => [p.type, p.value]));
      let guess = new Date(Date.UTC(+dp.year, +dp.month - 1, +dp.day, hh, mm, 0));
      // guess is a UTC instant; find what wall-clock time that instant reads as
      // in `tz`, then shift guess by the difference so it lands on hh:mm in tz.
      const checkFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const cp = Object.fromEntries(checkFmt.formatToParts(guess).map(p => [p.type, p.value]));
      const asUtcIfLocal = Date.UTC(+cp.year, +cp.month - 1, +cp.day, cp.hour === '24' ? 0 : +cp.hour, +cp.minute, +cp.second);
      const offsetMs = asUtcIfLocal - guess.getTime();
      let resetAt = new Date(guess.getTime() - offsetMs);
      if (resetAt.getTime() <= now.getTime()) resetAt = new Date(resetAt.getTime() + 24 * 3600 * 1000);
      const secs = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);
      if (secs > 0) return secs;
    } catch (e) { /* unknown tz or Intl failure — fall through to generic backoff */ }
  }
  return null;
}

function markDead(entry, deadType = 'rate') {
  entry.dead = true;
  entry.deadSince = Date.now();
  entry.deadType = deadType; // 'auth' = 5min bench, 'rate' = 30min bench
  entry.lastUsed = Date.now();
  entry.errorCount++;
  entry.activeRequests = Math.max(0, entry.activeRequests - 1);
  savePoolState();
  const retryIn = deadType === 'auth' ? '5m' : '30m';
  log(`Token ${entry.id} marked DEAD (${deadType} failure) — will auto-retry in ${retryIn}`);
}

function isCodexSessionStallError(err) {
  const msg = (err.message || '').toLowerCase();
  return err.statusCode === 404 ||
    msg.includes('no_biscuit_no_service') ||
    msg.includes('no biscuit') ||
    (msg.includes('biscuit') && msg.includes('service'));
}

function isCodexTransientError(err) {
  const msg = (err.message || '').toLowerCase();
  return err.statusCode === 0 ||
    (err.statusCode >= 500 && err.statusCode < 600) ||
    msg.includes('server_error') ||
	    msg.includes('network error calling codex') ||
	    msg.includes('empty response from codex') ||
	    msg.includes('produced no stream data') ||
	    msg.includes('produced no usable output') ||
	    msg.includes('stream stalled') ||
	    msg.includes('request to codex timed out');
}

function codexRequestHash(bodyStr) {
  return createHash('sha256').update(bodyStr).digest('hex').slice(0, 16);
}

function getCachedCodexFailure(hash) {
  const cached = codexRequestFailureCache.get(hash);
  if (!cached) return null;
  if (cached.until <= Date.now()) {
    codexRequestFailureCache.delete(hash);
    return null;
  }
  return cached;
}

function rememberCodexFailure(hash, err) {
  if (!hash || !err || !isCodexTransientError(err)) return;
  const existing = codexRequestFailureCache.get(hash);
  codexRequestFailureCache.set(hash, {
    until: Date.now() + CODEX_IDENTICAL_FAILURE_COOLDOWN,
    failures: (existing?.failures || 0) + 1,
    message: err.message || 'upstream Codex request stalled',
  });
}

function markRequestStart(entry) {
  entry.activeRequests++;
  entry.lastUsed = Date.now();
}

function markRequestEnd(entry) {
  entry.activeRequests = Math.max(0, entry.activeRequests - 1);
}

function getPoolStatus() {
  const now = Date.now();
  return {
    total: pool.length,
    available: pool.filter(t => !t.dead && (!t.cooldownUntil || t.cooldownUntil < now)).length,
    cooldown: pool.filter(t => !t.dead && t.cooldownUntil && t.cooldownUntil >= now).length,
    dead: pool.filter(t => t.dead).length,
    byProvider: {
      anthropic: pool.filter(t => t.provider === 'anthropic').length,
      openai: pool.filter(t => t.provider === 'openai').length,
    },
    tokens: pool.map(t => ({
      id: t.id ? t.id.slice(0, 4) + '...' : t.id,
      provider: t.provider,
      available: !t.dead && (!t.cooldownUntil || t.cooldownUntil < now),
      dead: t.dead,
      deadSince: t.deadSince,
      cooldownUntil: t.cooldownUntil,
      lastUsed: t.lastUsed,
      lastSuccess: t.lastSuccess,
      errorCount: t.errorCount,
      requestCount: t.requestCount,
      activeRequests: t.activeRequests,
    })),
  };
}

// Initialize pool
pool = loadTokenPool();
loadPoolState();

// Startup diagnostics
if (pool.length === 0) {
  log('WARN: No tokens loaded! SubStation has no credentials to use.');
  log('  → For Claude: Add OAuth tokens to auth-profiles.json (or set SUBSTATION_AUTH_PROFILES env var)');
  log('  → For ChatGPT: Run "substation-auth chatgpt"');
  log('  → Or set SUBSTATION_OAUTH_TOKEN env var');
} else {
  const anthropicCount = pool.filter(t => t.provider === 'anthropic').length;
  const openaiCount = pool.filter(t => t.provider === 'openai').length;
  log(`Token pool loaded: ${pool.length} tokens (anthropic=${anthropicCount}, openai=${openaiCount})`);
  if (anthropicCount === 0) log('WARN: No Anthropic tokens — Claude models will fail');
  if (openaiCount === 0) log('INFO: No OpenAI tokens — GPT models disabled. Run "substation-auth chatgpt" to add.');
}

// Periodic maintenance (every 30s)
setInterval(() => {
  const now = Date.now();
  for (const t of pool) {
    // Clear expired cooldowns
    if (t.cooldownUntil && t.cooldownUntil < now) {
      log(`Token ${t.id} cooldown expired, re-enabling`);
      t.cooldownUntil = null;
      savePoolState();
    }
    // Auto-revive dead tokens (30m for rate failures, 5m for auth/session failures)
    if (t.dead && t.deadSince) {
      const ttl = t.deadType === 'auth' ? AUTH_DEAD_REVIVE_MS : DEAD_REVIVE_MS;
      if ((now - t.deadSince) > ttl) {
        log(`Token ${t.id} was dead for ${t.deadType === 'auth' ? '5m' : '30m'}+ — reviving for retry`);
        t.dead = false;
        t.deadSince = null;
        t.deadType = null;
        t.errorCount = 0;
        savePoolState();
      }
    }
    // Reset stuck activeRequests counter (safety valve for leaked counters)
    if (t.activeRequests > 0 && t.lastUsed && (now - t.lastUsed) > TIMEOUT + 10000) {
      log(`Token ${t.id} had ${t.activeRequests} stuck active requests — resetting`);
      t.activeRequests = 0;
    }
  }
}, 30000);

// Watch token-pool.json for changes (hot-reload without restart)
try {
  let reloadDebounce = null;
  watch(POOL_FILE, () => {
    if (reloadDebounce) return;
    reloadDebounce = setTimeout(() => {
      reloadDebounce = null;
      const oldCount = pool.length;
      pool = loadTokenPool();
      loadPoolState();
      if (pool.length !== oldCount) {
        log(`Token pool hot-reloaded: ${oldCount} → ${pool.length} tokens`);
      }
    }, 1000);
  });
} catch {
  // File doesn't exist yet — will be created by substation-auth
}

// ---------------------------------------------------------------------------
// OpenAI token refresh
// ---------------------------------------------------------------------------

function refreshOpenAIToken(entry) {
  return new Promise((resolve, reject) => {
    if (!entry.refreshToken) return reject(new Error('No refresh token'));

    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: entry.refreshToken,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });

    const req = httpsRequest({
      hostname: 'auth.openai.com',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            entry.token = parsed.access_token;
            if (parsed.refresh_token) entry.refreshToken = parsed.refresh_token;
            entry.dead = false;
            entry.deadSince = null;
            entry.errorCount = 0;
            // Persist refreshed tokens to pool file
            try {
              const poolData = JSON.parse(readFileSync(POOL_FILE, 'utf8'));
              for (const t of (poolData.tokens || [])) {
                if (t.id === entry.id) {
                  t.token = entry.token;
                  if (entry.refreshToken) t.refreshToken = entry.refreshToken;
                }
              }
              const tmp = POOL_FILE + '.tmp';
              writeFileSync(tmp, JSON.stringify(poolData, null, 2));
              renameSync(tmp, POOL_FILE);
            } catch {}
            log(`Token ${entry.id} refreshed successfully`);
            resolve(entry);
          } catch (e) {
            reject(new Error(`Refresh parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Refresh failed (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Refresh timeout')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Image handling — save base64 images to temp files for agent vision
// ---------------------------------------------------------------------------

const SUBSTATION_IMG_DIR = '/tmp/substation-images';
try { mkdirSync(SUBSTATION_IMG_DIR, { recursive: true }); } catch {}

function extractImageBlocks(contentArray) {
  const images = [];
  if (!Array.isArray(contentArray)) return images;
  for (const block of contentArray) {
    if ((block.type === 'image_url' || block.type === 'input_image') && block.image_url) {
      const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url.url;
      if (!imageUrl) continue;
      const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/s);
      if (match) {
        images.push({ mediaType: match[1], data: match[2] });
      } else {
        images.push({ url: imageUrl });
      }
    } else if (block.type === 'image' && block.source?.data) {
      images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data });
    }
  }
  return images;
}

function saveImageToTmp(imageBlock) {
  const ext = (imageBlock.mediaType || 'image/png').split('/')[1] || 'png';
  const filename = `img-${randomUUID().slice(0, 8)}.${ext}`;
  const filepath = join(SUBSTATION_IMG_DIR, filename);
  if (imageBlock.data) {
    writeFileSync(filepath, Buffer.from(imageBlock.data, 'base64'));
  }
  return filepath;
}

function convertImageToAnthropic(imageBlock) {
  if (imageBlock.data) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: imageBlock.mediaType || 'image/png', data: imageBlock.data },
    };
  }
  if (imageBlock.url) {
    return {
      type: 'image',
      source: { type: 'url', url: imageBlock.url },
    };
  }
  return null;
}

function codexTextPartType(role) {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function addCodexImagePart(parts, imageUrl, detail) {
  if (!imageUrl || typeof imageUrl !== 'string') return;
  const normalizedUrl = normalizeCodexImageUrl(imageUrl);
  if (!normalizedUrl) return;
  const imagePart = { type: 'input_image', image_url: normalizedUrl };
  if (typeof detail === 'string' && detail.trim()) {
    imagePart.detail = detail.trim();
  }
  parts.push(imagePart);
}

function imageMimeTypeForPath(filepath) {
  const lower = filepath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function normalizeCodexImageUrl(imageUrl) {
  const trimmed = imageUrl.trim();
  if (!trimmed) return '';
  if (/^(data:image\/|https?:\/\/)/i.test(trimmed)) return trimmed;

  let filepath = trimmed;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      filepath = new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  }

  if (!filepath.startsWith('/')) return trimmed;
  try {
    const st = statSync(filepath);
    if (!st.isFile() || st.size > 25 * 1024 * 1024) return trimmed;
    const mimeType = imageMimeTypeForPath(filepath);
    return `data:${mimeType};base64,${readFileSync(filepath).toString('base64')}`;
  } catch {
    return trimmed;
  }
}

function convertContentToCodexParts(content, role = 'user', options = {}) {
  const parts = [];
  const textType = codexTextPartType(role);
  const allowImages = options.allowImages !== false && role !== 'assistant';

  if (!Array.isArray(content)) {
    const text = content == null ? '' : String(content);
    if (text) parts.push({ type: textType, text });
    return parts;
  }

  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: textType, text: block });
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    const blockType = String(block.type || '').toLowerCase();
    if (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text') {
      if (typeof block.text === 'string' && block.text) {
        parts.push({ type: textType, text: block.text });
      }
    } else if (allowImages && (blockType === 'image_url' || blockType === 'input_image')) {
      let imageUrl = '';
      let detail = block.detail;
      const imageRef = block.image_url;
      if (typeof imageRef === 'string') {
        imageUrl = imageRef;
      } else if (imageRef && typeof imageRef === 'object') {
        imageUrl = imageRef.url || '';
        detail = imageRef.detail || detail;
      }
      addCodexImagePart(parts, imageUrl, detail);
    } else if (allowImages && blockType === 'image' && block.source?.data) {
      const mediaType = block.source.media_type || 'image/png';
      addCodexImagePart(parts, `data:${mediaType};base64,${block.source.data}`, block.detail);
    }
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Message conversion — OpenAI chat format → provider-native format
// ---------------------------------------------------------------------------

function convertForAnthropic(openaiMessages) {
  // Operator identity first (overrides Claude Code default), then CC prefix (fingerprint match)
  const systemBlocks = [
    { type: 'text', text: OPERATOR_SYSTEM_PROMPT },
    { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
  ];
  const messages = [];

  for (const m of openaiMessages) {
    const textContent = Array.isArray(m.content)
      ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (m.content || '');
    const imageBlocks = extractImageBlocks(m.content);

    if (m.role === 'system') {
      systemBlocks.push({ type: 'text', text: textContent });
    } else {
      const contentBlocks = [];
      if (textContent) contentBlocks.push({ type: 'text', text: textContent });
      for (const img of imageBlocks) {
        const converted = convertImageToAnthropic(img);
        if (converted) contentBlocks.push(converted);
      }
      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: contentBlocks.length === 1 && contentBlocks[0].type === 'text'
          ? contentBlocks[0].text
          : contentBlocks.length > 0 ? contentBlocks : textContent || '(empty)',
      });
    }
  }

  // Anthropic requires alternating roles starting with user
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '(continue)' });
  }
  // Merge consecutive same-role messages (text-only merge; multimodal stays separate)
  const merged = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content += '\n\n' + msg.content;
      } else {
        const prevBlocks = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content;
        const newBlocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
        prev.content = [...prevBlocks, ...newBlocks];
      }
    } else {
      merged.push({ ...msg });
    }
  }
  if (merged.length === 0) {
    merged.push({ role: 'user', content: '(empty)' });
  }

  return { system: systemBlocks, messages: merged };
}

function convertForCodex(openaiMessages) {
  const input = [];
  const resultIds = new Set(openaiMessages.filter(m => m.role === 'tool' && typeof m.tool_call_id === 'string').map(m => m.tool_call_id));
  const emittedCalls = new Set();
  for (const m of openaiMessages) {
    if (m.role === 'system' || m.role === 'developer') {
      // developer/system → typed message item
      const parts = convertContentToCodexParts(m.content, 'developer', { allowImages: false });
      input.push({ type: 'message', role: 'developer', content: parts.length ? parts : [{ type: 'input_text', text: '' }] });
    } else if (m.role === 'assistant') {
      // assistant messages use output_text content type
      const parts = convertContentToCodexParts(m.content, 'assistant', { allowImages: false });
      const pairedCalls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter(call =>
        typeof call.id === 'string' && resultIds.has(call.id) && typeof call.function?.name === 'string');
      if (parts.length || !pairedCalls.length) input.push({ type: 'message', role: 'assistant', content: parts.length ? parts : [{ type: 'output_text', text: '' }] });
      for (const call of pairedCalls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {}) });
        emittedCalls.add(call.id);
      }
    } else if (m.role === 'user') {
      const parts = convertContentToCodexParts(m.content, 'user');
      input.push({ type: 'message', role: 'user', content: parts.length ? parts : [{ type: 'input_text', text: '' }] });
    } else if (m.role === 'tool' || m.role === 'function') {
      if (m.role === 'tool' && emittedCalls.has(m.tool_call_id)) {
        input.push({ type: 'function_call_output', call_id: m.tool_call_id,
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
        continue;
      }
      // Tool results may carry Anthropic call_ids that Codex won't recognize.
      // Always fold into user context instead of sending as function_call_output.
      const label = m.name ? `[tool: ${m.name}]` : `[${m.role} result]`;
      const parts = convertContentToCodexParts(m.content, 'user');
      if (parts.length && parts[0].type === 'input_text') {
        parts[0] = { ...parts[0], text: `${label}: ${parts[0].text}` };
      } else {
        parts.unshift({ type: 'input_text', text: `${label}:` });
      }
      input.push({ type: 'message', role: 'user', content: parts });
    } else {
      // unknown role — fold into user
      const parts = convertContentToCodexParts(m.content, 'user');
      if (parts.length && parts[0].type === 'input_text') {
        parts[0] = { ...parts[0], text: `[${m.role}]: ${parts[0].text}` };
      } else {
        parts.unshift({ type: 'input_text', text: `[${m.role}]:` });
      }
      input.push({ type: 'message', role: 'user', content: parts });
    }
  }
  if (input.length === 0) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '(empty)' }] });
  }
  return input;
}

// ---------------------------------------------------------------------------
// Request body builders
// ---------------------------------------------------------------------------

function logEffectiveEffort(model, path, resolved) {
  const effort = resolved?.effort || 'none';
  const source = resolved?.source || 'default';
  log(`Reasoning effort (model=${model}, path=${path}, effort=${effort}, source=${source})`);
}

// ---------------------------------------------------------------------------
// Request end-of-life logging (WO 2026-09-25 fix2) — every request on the 5
// invokeClaude*/invokeCodex functions must log exactly one END line, paired
// by requestId with that same request's START line(s), so a hang/timeout/
// disconnect is provably distinguishable in substation.log from "still
// running" (this is what the Muse-setter silent-request gap was missing).
// ---------------------------------------------------------------------------
const VALID_REQUEST_OUTCOMES = new Set(['ok', 'error', 'idle-timeout', 'hard-timeout', 'client-disconnect']);

function logRequestEnd({ requestId, path, model, tokenId, resumed, startedAt, outcome }) {
  const duration = Date.now() - startedAt;
  const safeOutcome = VALID_REQUEST_OUTCOMES.has(outcome) ? outcome : 'error';
  log(`Request end (id=${requestId}, path=${path}, model=${model || 'unknown'}, token=${tokenId || 'none'}, resumed=${resumed}, duration=${duration}ms, outcome=${safeOutcome})`);
}

// Classifies a thrown error into one of the outcome labels above, using only
// the exact phrases each path's OWN timeout timers produce (never a guessed
// generic "timeout" match) — see the per-function comments at each timer for
// the source strings. A path with only one real timeout concept (no
// idle/hard distinction in that function) only ever returns that one kind.
function classifyInvokeError(path, err) {
  const msg = ((err && err.message) || '').toLowerCase();
  switch (path) {
    case 'invokeClaudeSDK':
      // invokeClaudeSDK has BOTH a real idle timer (resets on stream
      // activity — see resetIdleTimer/IDLE_TIMEOUT/TOOL_IDLE_TIMEOUT) and a
      // real hard wall-clock cap (HARD_TIMEOUT_MS, never reset).
      if (msg.includes('no stream activity')) return 'idle-timeout';
      if (msg.includes('hard timeout')) return 'hard-timeout';
      return 'error';
    case 'invokeClaudeSDKWithTools':
      // Only a hard wall-clock cap exists here (HARD_TIMEOUT_MS) — no idle
      // timer in this path, so never report idle-timeout for it.
      if (msg.includes('hard timeout')) return 'hard-timeout';
      return 'error';
    case 'invokeClaudeDirect':
    case 'invokeClaudeMessagesAPIWithTools':
      // Both share the single absolute TIMEOUT constant (makeAnthropicDirectRequest
      // / makeAnthropicRequest) — one setTimeout, never reset on activity, so
      // this is a hard cap only; there is no idle concept in either path.
      if (msg.includes('timed out after')) return 'hard-timeout';
      return 'error';
    case 'invokeCodex':
      // makeCodexRequest has a real idle/progress timer (resetProgressTimer,
      // reset on every SSE event — plus the pre-first-byte variant) AND a
      // separate absolute per-attempt cap (CODEX_ATTEMPT_TIMEOUT).
      if (msg.includes('stalled after') || msg.includes('produced no stream data after')) return 'idle-timeout';
      if (msg.includes('timed out after')) return 'hard-timeout';
      return 'error';
    default:
      return 'error';
  }
}

// buildAnthropicBody kept for fallback only (not used in primary Agent SDK path)
function buildAnthropicBody(openaiMessages, modelInfo, requestedEffort = null) {
  const { system, messages } = convertForAnthropic(openaiMessages);
  const body = {
    model: modelInfo.modelId,
    max_tokens: modelInfo.maxTokens,
    system,
    messages,
  };
  if (modelInfo.adaptive) {
    const effort = resolveClaudeReasoningEffort(requestedEffort);
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: effort.effort };
  }
  return body;
}

// ChatGPT (Plus/Pro) subscription accounts reach OpenAI only via the Codex
// /backend-api/codex/responses endpoint, which REJECTS the gpt-5.1-codex* model
// family with HTTP 400 ("not supported when using Codex with a ChatGPT account").
// gpt-5.4 / gpt-5.4-mini ARE accepted. Remap any codex model to its supported
// equivalent so failover never dead-ends on a blocked model. Verified 2026-06-04.
const CODEX_CHATGPT_REMAP = {
  'gpt-5.3-codex':      'gpt-5.3-codex',
  'gpt-5.1-codex':      'gpt-5.4',
  'gpt-5.1-codex-max':  'gpt-5.4',
  'gpt-5.1-codex-mini': 'gpt-5.4-mini',
};

// Best-effort OpenAI chat-completions tool schema -> Responses API tool shape.
// NOTE: the Responses API's tool shape is FLATTER than Chat Completions —
// {type:'function', name, description, parameters} directly, NOT nested under
// a `function` key. This is unverified against a live ChatGPT/codex backend
// probe as of writing; treat as best-effort, document honestly if it fails.
function convertOpenAIToolsToCodexResponses(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    name: t.function?.name,
    description: t.function?.description,
    parameters: t.function?.parameters || { type: 'object', properties: {} },
  }));
}

function buildCodexBody(openaiMessages, modelInfo, tools, requestedEffort = null) {
  const input = convertForCodex(openaiMessages);
  // Extract instructions from developer messages, remaining go in input
  let instructions = '';
  const filteredInput = [];
  for (const m of input) {
    if (m.type === 'message' && m.role === 'developer') {
      const text = (m.content || []).filter(c => c.type === 'input_text').map(c => c.text).join('\n');
      instructions += (instructions ? '\n' : '') + text;
    } else {
      filteredInput.push(m);
    }
  }
  if (!instructions) {
    instructions = 'You are a helpful coding assistant.';
  }
  const toolNames = (tools || [])
    .map(t => t?.function?.name)
    .filter(Boolean);
  instructions += HERMES_RUNTIME_PROMPT;
  if (toolNames.length) {
    instructions += `\n\nAvailable tool names in this request: ${toolNames.join(', ')}.`;
  }
  if (filteredInput.length === 0) {
    filteredInput.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '(empty)' }] });
  }
  const body = {
    model: CODEX_CHATGPT_REMAP[modelInfo.modelId] || modelInfo.apiModel || modelInfo.modelId,
    instructions,
    input: filteredInput,
    store: false,
    stream: true,
    service_tier: 'priority',
  };
  const resolvedEffort = resolveCodexReasoningEffort(requestedEffort, modelInfo);
  if (modelInfo.reasoningMode || resolvedEffort.effort) {
    body.reasoning = {};
    if (modelInfo.reasoningMode) body.reasoning.mode = modelInfo.reasoningMode;
    if (resolvedEffort.effort) body.reasoning.effort = resolvedEffort.effort;
  }
  const codexTools = convertOpenAIToolsToCodexResponses(tools);
  if (codexTools) body.tools = codexTools;
  return body;
}

function extractCodexOutputText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractCodexOutputText).filter(Boolean).join('');
  if (typeof value !== 'object') return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return extractCodexOutputText(value.content);
  if (Array.isArray(value.output)) return extractCodexOutputText(value.output);
  if (value.type === 'message' && Array.isArray(value.content)) return extractCodexOutputText(value.content);
  if ((value.type === 'output_text' || value.type === 'text') && typeof value.text === 'string') return value.text;
  return '';
}

// ---------------------------------------------------------------------------
// HTTPS request helpers
// ---------------------------------------------------------------------------

function makeAnthropicRequest(bodyStr, tokenEntry, onDelta) {
  // Enable streaming if we have an onDelta callback
  let actualBodyStr = bodyStr;
  if (onDelta) {
    try {
      const parsed = JSON.parse(bodyStr);
      parsed.stream = true;
      actualBodyStr = JSON.stringify(parsed);
    } catch {}
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA_HEADERS,
        'Authorization': `Bearer ${tokenEntry.token}`,
        // Matches the proven-working /v1/messages passthrough exactly (see
        // startProxy()'s proxyHeaders) -- the stale 'claude-cli' identity this
        // used to send appears to get bucketed into a much harsher rate limit
        // by Anthropic's OAuth backend than a client fingerprint matching the
        // real Claude Code CLI. Root-caused live: this function's old headers
        // produced persistent 429s while the identical-token /v1/messages path
        // succeeded in parallel at the same time.
        'anthropic-client-type': 'claude-code',
        'anthropic-client-version': '2.1.197',
        'User-Agent': 'claude-code/2.1.197',
        'Content-Length': Buffer.byteLength(actualBodyStr),
      },
    };

    const req = httpsRequest(options, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          reject(Object.assign(
            new Error(`Anthropic API error ${res.statusCode}: ${data.slice(0, 300)}`),
            { statusCode: res.statusCode, retryAfter: res.headers['retry-after'] }
          ));
        });
        return;
      }

      // Capture per-account 5h/7d usage off this real 200. makeAnthropicRequest
      // sends full Claude-Code framing, so unlike a bare probe it isn't edge-429'd
      // and the anthropic-ratelimit-unified-* headers ride along on the response.
      recordUsageHeaders(tokenEntry, res.headers);

      if (onDelta) {
        // Streaming mode — parse SSE incrementally
        let text = '';
        let usage = {};
        let buf = '';

        res.on('data', (chunk) => {
          buf += chunk;
          let nlIdx;
          while ((nlIdx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 1);
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const event = JSON.parse(payload);
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                text += event.delta.text;
                onDelta(event.delta.text);
              } else if (event.type === 'message_delta' && event.usage) {
                usage = { ...usage, output_tokens: event.usage.output_tokens };
              } else if (event.type === 'message_start' && event.message?.usage) {
                usage = { ...usage, input_tokens: event.message.usage.input_tokens };
              }
            } catch {}
          }
        });

        res.on('end', () => {
          if (text) {
            resolve({ text, usage });
          } else {
            reject(Object.assign(new Error('Empty response from Anthropic — model returned no text blocks'), { statusCode: 0 }));
          }
        });
      } else {
        // Non-streaming — buffer full response
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Return the full content blocks array (text + tool_use, etc.) so
            // callers that need structured tool_use data (e.g.
            // invokeClaudeMessagesAPIWithTools) don't lose it to a text-only
            // join. Callers that only want text can still derive it themselves.
            if (parsed.content && parsed.content.length) {
              resolve({ content: parsed.content, usage: parsed.usage || {} });
            } else {
              reject(Object.assign(new Error('Empty response from Anthropic — model returned no content blocks'), { statusCode: 0 }));
            }
          } catch (e) {
            reject(Object.assign(new Error(`Failed to parse Anthropic response: ${e.message}`), { statusCode: 0 }));
          }
        });
      }
    });
    req.on('error', e => reject(Object.assign(new Error(`Network error calling Anthropic: ${e.message}`), { statusCode: 0 })));
    const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('Request to Anthropic timed out after 5 minutes'), { statusCode: 0 })); }, TIMEOUT);
    req.on('close', () => clearTimeout(timer));
    req.write(actualBodyStr);
    req.end();
  });
}

function getCodexServedModel(event) {
  const model = event?.response?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

// Bounded error contract: no provider payload text is returned to clients.
function codexFailureCode(err) {
  if (err?.code === 'ABORT_ERR') return 'codex_canceled';
  const message = err?.message || '';
  if (message.includes('Empty response from Codex')) return 'codex_empty_stream';
  if (message.includes('before response.completed')) return 'codex_unfinished_stream';
  if (message.includes('no stream data')) return 'codex_no_first_byte';
  if (message.includes('stream stalled')) return 'codex_progress_stall';
  if (message.includes('response incomplete')) return 'codex_incomplete';
  if (message.includes('malformed response.completed')) return 'codex_invalid_terminal';
  if (err?.statusCode === 401 || err?.statusCode === 403) return 'codex_auth_error';
  if (err?.statusCode === 429) return 'codex_rate_limited';
  return 'codex_upstream_error';
}
function upstreamErrorEnvelope(err, requestId) {
  const outputObserved = Boolean(err?.codexOutputObserved);
  const canceled = err?.code === 'ABORT_ERR';
  return { error: {
    type: 'substation_upstream_error', code: codexFailureCode(err),
    message: 'The response stopped. Completed actions are retained; the final explanation is incomplete.',
    substation: { request_id: requestId, output_observed: outputObserved,
      retryable: !canceled && !outputObserved && (err?.statusCode === 0 || err?.statusCode === 429 || err?.statusCode >= 500),
      upstream_attempts: Number.isSafeInteger(err?.codexAttempts) ? err.codexAttempts : 0,
      retry_budget_remaining: Number.isSafeInteger(err?.codexRetryBudgetRemaining) ? err.codexRetryBudgetRemaining : 0,
    },
  } };
}
function codexWireValue(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
}

function makeCodexRequest(bodyStr, tokenEntry, onDelta, onServedModel = null, requestSignal = null, wireContext = null) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let firstByteTimer = null;
    let progressTimer = null;
    let firstByteSeen = false;
    let settled = false;
    let outputObserved = false;
    let abortRequest = null;
    const wireStarted = Date.now();
    const wire = { http_status: null, upstream_request: null, upstream_response: null, served_model: null,
      bytes: 0, events: 0, event_types: {}, first_byte_ms: null, first_event_ms: null, terminal: 'none', header_ms: null };
    const recordWire = (outcome, err = null) => {
      try {
      const fields = { event: 'codex_attempt_end', wrapper: wireContext?.wrapper || null, proxy: wireContext?.proxy || null, upstream_attempt: wireContext?.attempt || 1,
        ...wire, outcome, duration_ms: Date.now() - wireStarted, output_observed: outputObserved,
        error_code: err ? codexFailureCode(err) : null };
      // Generic logs retain IDs even for native callers without managed headers.
      log('Codex wire ' + JSON.stringify(fields));
      if (wireContext?.correlation) logUsageJoin(wireContext.correlation, fields);
      } catch {}
    };

    const cleanupTimers = () => {
      if (abortRequest) requestSignal?.removeEventListener('abort', abortRequest);
      if (timer) clearTimeout(timer);
      if (firstByteTimer) clearTimeout(firstByteTimer);
      if (progressTimer) clearTimeout(progressTimer);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      err.codexOutputObserved = outputObserved;
      recordWire('error', err);
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      recordWire('ok');
      resolve(value);
    };
    const resetProgressTimer = () => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        req.destroy();
        fail(Object.assign(new Error(`Request to Codex stream stalled after ${Math.round(CODEX_PROGRESS_TIMEOUT / 1000)}s without events`), { statusCode: 0 }));
      }, CODEX_PROGRESS_TIMEOUT);
    };

    const options = {
      hostname: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${tokenEntry.token}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = httpsRequest(options, (res) => {
      wire.http_status = res.statusCode;
      wire.header_ms = Date.now() - wireStarted;
      wire.upstream_request = codexWireValue(res.headers['x-request-id'] || res.headers['request-id']);
      if (settled) return;
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 403) {
            fail(Object.assign(
              new Error('Codex API returned 403 — the ChatGPT/Codex auth session may be expired. Run "substation-auth chatgpt" if refresh fails.'),
              { statusCode: 401, retryAfter: null }
            ));
          } else if (res.statusCode === 404) {
            fail(Object.assign(
              new Error('Codex API returned 404 — the ChatGPT/Codex backend path or session is temporarily unavailable; keeping token alive.'),
              { statusCode: 404, retryAfter: res.headers['retry-after'] }
            ));
          } else {
            fail(Object.assign(
              new Error(`Codex API error ${res.statusCode}: ${data.slice(0, 300)}`),
              { statusCode: res.statusCode, retryAfter: res.headers['retry-after'] }
            ));
          }
        });
        res.on('error', e => fail(Object.assign(new Error(`Network error reading Codex error response: ${e.message}`), { statusCode: 0 })));
        return;
      }
      // Decode across Buffer boundaries; coercing each chunk corrupts UTF-8.
      res.setEncoding?.('utf8');
      resetProgressTimer();

      // Stream SSE — parse incrementally
      let completed = false;
      let text = '';
      let usage = {};
      let servedModel = null;
      let buf = '';
      // Best-effort: capture function_call output items if the codex/Responses
      // backend surfaces them (see convertOpenAIToolsToCodexResponses above).
      // Unverified live — may end up empty even when tools were sent.
      const toolCalls = [];
      const toolCallById = new Map();

      const rememberToolCall = (item = {}) => {
        const key = item.id || item.call_id;
        if (!key) return null;
        outputObserved = true;
        let call = toolCallById.get(key);
        if (!call) {
          call = {
            id: item.call_id || item.id,
            type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '' },
          };
          toolCallById.set(key, call);
          toolCalls.push(call);
        } else {
          call.id = item.call_id || call.id || item.id;
          if (item.name) call.function.name = item.name;
          if (typeof item.arguments === 'string') call.function.arguments = item.arguments;
        }
        return call;
      };

      const findToolCallForEvent = (event) => {
        if (event.item_id && toolCallById.has(event.item_id)) return toolCallById.get(event.item_id);
        if (event.call_id && toolCallById.has(event.call_id)) return toolCallById.get(event.call_id);
        if (toolCalls.length === 1) return toolCalls[0];
        return null;
      };

      res.on('data', (chunk) => {
        if (settled) return;
        wire.bytes += Buffer.byteLength(chunk);
        if (!firstByteSeen) {
          firstByteSeen = true;
          wire.first_byte_ms = Date.now() - wireStarted;
          if (firstByteTimer) clearTimeout(firstByteTimer);
        }
        buf += chunk;
        // Process complete lines
        let nlIdx;
        while ((nlIdx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload);
            wire.events++;
            if (wire.first_event_ms === null) wire.first_event_ms = Date.now() - wireStarted;
            const knownTypes = ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_text.done',
              'response.output_item.added', 'response.output_item.done', 'response.function_call_arguments.delta',
              'response.function_call_arguments.done', 'response.completed', 'response.incomplete', 'response.failed', 'error'];
            const eventKind = knownTypes.includes(event.type) ? event.type : 'other';
            wire.event_types[eventKind] = (wire.event_types[eventKind] || 0) + 1;
            if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(eventKind)) wire.terminal = eventKind;
            const upstreamResponse = codexWireValue(event.response?.id);
            if (upstreamResponse) wire.upstream_response = upstreamResponse;
            resetProgressTimer();
            // Identity is taken only from the upstream Responses envelope.
            const upstreamModel = getCodexServedModel(event);
            if (upstreamModel && upstreamModel !== servedModel) {
              servedModel = upstreamModel;
              wire.served_model = codexWireValue(upstreamModel);
              if (onServedModel) { try { onServedModel(servedModel); } catch {} }
            }
            if (event.type === 'response.output_text.delta' && event.delta) {
              outputObserved = true;
              text += event.delta;
              if (onDelta) onDelta(event.delta);
            } else if (event.type === 'response.output_text.done') {
              if (event.text) { outputObserved = true; text = event.text; }
	            } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
	              rememberToolCall(event.item);
	            } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
	              rememberToolCall(event.item);
	            } else if (event.type === 'response.output_item.done') {
	              const itemText = extractCodexOutputText(event.item);
	              if (!text && itemText) { outputObserved = true; text = itemText; }
	            } else if (event.type === 'response.function_call_arguments.delta') {
	              const call = findToolCallForEvent(event);
	              if (call && event.delta) call.function.arguments += event.delta;
	            } else if (event.type === 'response.function_call_arguments.done') {
	              const call = findToolCallForEvent(event);
	              if (call && typeof event.arguments === 'string') call.function.arguments = event.arguments;
	            } else if (event.type === 'response.completed') {
                  if (!event.response || typeof event.response !== 'object' || (event.response.status && event.response.status !== 'completed')) {
                    fail(Object.assign(new Error('Codex malformed response.completed terminal event'), { statusCode: 0 }));
                    req.destroy();
                    return;
                  }
                  completed = true;
	              if (event.response?.usage) usage = event.response.usage;
	              if (!text) {
	                const finalText = extractCodexOutputText(event.response?.output);
	                if (finalText) { outputObserved = true; text = finalText; }
	              }
	              // Fallback: some backends only surface function_call items in the
              // final response.completed payload's output array, not as their
              // own output_item.done events.
              if (Array.isArray(event.response?.output)) {
                for (const item of event.response.output) {
                  if (item.type === 'function_call') {
                    rememberToolCall(item);
                  }
                }
              }
            } else if (event.type === 'response.incomplete') {
              fail(Object.assign(new Error(`Codex response incomplete: ${['max_output_tokens', 'content_filter'].includes(event.response?.incomplete_details?.reason) ? event.response.incomplete_details.reason : 'unknown'}`), { statusCode: 0 }));
              req.destroy();
              return;
            } else if (event.type === 'error') {
              fail(Object.assign(new Error('Codex upstream error event'), { statusCode: 0 }));
              req.destroy();
              return;
            } else if (event.type === 'response.failed') {
              const errMsg = event.response?.error?.message || 'Unknown Codex error';
              const errCode = event.response?.error?.code || '';
              const err = new Error(`Codex API error: ${errMsg} (${errCode})`);
              fail(Object.assign(err, { statusCode: isCodexSessionStallError(err) ? 0 : 0 }));
              req.destroy();
              return;
            }
          } catch {}
        }
      });

      res.on('end', () => {
        if (!completed && (text || toolCalls.length)) {
          fail(Object.assign(new Error('Codex stream ended before response.completed; output is incomplete'), { statusCode: 0 }));
        } else if (text || toolCalls.length) {
          succeed({ text, usage, servedModel, toolCalls: toolCalls.length ? toolCalls : undefined });
        } else {
          fail(Object.assign(new Error('Empty response from Codex API — upstream stream ended without text or tool calls; treating as transient and retrying/failing over'), { statusCode: 0 }));
        }
      });
      res.on('aborted', () => fail(Object.assign(new Error('Codex response aborted before completion'), { statusCode: 0 })));
      res.on('error', e => fail(Object.assign(new Error(`Network error reading Codex response: ${e.message}`), { statusCode: 0 })));
    });
    req.on('error', e => fail(Object.assign(new Error(`Network error calling Codex: ${e.message}`), { statusCode: 0 })));
    timer = setTimeout(() => {
      req.destroy();
      fail(Object.assign(new Error(`Request to Codex timed out after ${Math.round(CODEX_ATTEMPT_TIMEOUT / 1000)}s`), { statusCode: 0 }));
    }, CODEX_ATTEMPT_TIMEOUT);
    firstByteTimer = setTimeout(() => {
      req.destroy();
      fail(Object.assign(new Error(`Request to Codex produced no stream data after ${Math.round(CODEX_FIRST_BYTE_TIMEOUT / 1000)}s`), { statusCode: 0 }));
    }, CODEX_FIRST_BYTE_TIMEOUT);
    abortRequest = () => {
      fail(Object.assign(new Error('Codex request canceled by client'), { code: 'ABORT_ERR', statusCode: 0 }));
      req.destroy();
    };
    if (requestSignal?.aborted) { abortRequest(); return; }
    requestSignal?.addEventListener('abort', abortRequest, { once: true });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ChatGPT Image Generation — via Codex/Responses API (bypasses Cloudflare)
// ---------------------------------------------------------------------------

const IMAGE_REF_MAX_COUNT = 4;
const IMAGE_REF_MAX_BYTES = 4 * 1024 * 1024;

function imageRefError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return 'image/png';
}

// JPEG base64 begins with "/9j/", which also looks like an absolute path; disambiguate.
function looksLikeJpegBase64(v) {
  return v.startsWith('/9j/') && /^[A-Za-z0-9+/=\s]+$/.test(v) && !existsSync(v);
}

// Resolve the optional `image` field of /v1/images/generations into input_image
// parts. Throws an Error with statusCode 400 on any invalid input (never drops).
function resolveImageRefs(image) {
  if (image === undefined || image === null) return [];
  const list = Array.isArray(image) ? image : [image];
  if (list.length === 0) throw imageRefError('image must not be an empty array');
  if (list.length > IMAGE_REF_MAX_COUNT) {
    throw imageRefError(`Too many reference images: ${list.length} (max ${IMAGE_REF_MAX_COUNT})`);
  }
  return list.map((item, idx) => {
    const label = `image[${idx}]`;
    if (typeof item !== 'string' || !item.trim()) throw imageRefError(`${label} must be a non-empty string (data URL, base64, or absolute path)`);
    const v = item.trim();
    let buf;
    let mime;
    if (/^data:/i.test(v)) {
      const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(v);
      if (!m) throw imageRefError(`${label} is not a valid base64 image data URL`);
      buf = Buffer.from(m[2], 'base64');
      mime = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    } else if (v.startsWith('/') && !looksLikeJpegBase64(v)) {
      let st;
      try { st = statSync(v); } catch { throw imageRefError(`${label}: file not found or unreadable`); }
      if (!st.isFile()) throw imageRefError(`${label}: path is not a file`);
      if (st.size > IMAGE_REF_MAX_BYTES) throw imageRefError(`${label} exceeds ${IMAGE_REF_MAX_BYTES} bytes (${st.size})`);
      try { buf = readFileSync(v); } catch { throw imageRefError(`${label}: file not readable`); }
      mime = sniffImageMime(buf);
    } else {
      if (v.length % 4 === 1 || !/^[A-Za-z0-9+/=\s]+$/.test(v)) throw imageRefError(`${label} is not a data URL, valid base64, or absolute path`);
      buf = Buffer.from(v, 'base64');
      mime = sniffImageMime(buf);
    }
    if (buf.length === 0) throw imageRefError(`${label} decoded to zero bytes`);
    if (buf.length > IMAGE_REF_MAX_BYTES) throw imageRefError(`${label} exceeds ${IMAGE_REF_MAX_BYTES} bytes (${buf.length})`);
    return { type: 'input_image', image_url: `data:${mime};base64,${buf.toString('base64')}` };
  });
}

function chatgptImageGenerate(tokenEntry, prompt, size = '1024x1024', quality = 'high', imageParts = []) {
  return new Promise((resolve, reject) => {
    // Use GPT 5.5 through the Codex/Responses endpoint — it supports native image generation
    // gpt-image-1 is also accepted by this endpoint as of 2026-07-09 (live-probed), but
    // gpt-image-2 remains the tool model since no proven newer id was found -- see
    // /tmp/substation_image_patch.md (commit b3d0faa) for the full probe evidence.
    // Send as a plain text input — GPT 5.5 auto-generates images when the prompt describes one
    const requestBody = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'Generate the requested image. Output only the image.',
      input: [{ role: 'user', content: imageParts.length ? [{ type: 'input_text', text: prompt }, ...imageParts] : prompt }],
      tools: [{ type: 'image_generation', model: 'gpt-image-2', size, quality }],
      store: false,
      stream: true,
    });

    const options = {
      hostname: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${tokenEntry.token}`,
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const req = httpsRequest(options, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          reject(Object.assign(
            new Error(`Codex image API error ${res.statusCode}: ${data.slice(0, 500)}`),
            { statusCode: res.statusCode }
          ));
        });
        return;
      }

      let buf = '';
      let imageB64 = null;

      res.on('data', (chunk) => {
        buf += chunk;
        let nlIdx;
        while ((nlIdx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 1);
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload);

            // Responses API image output events — multiple formats
            if (event.type === 'response.image.delta' && event.delta) {
              imageB64 = (imageB64 || '') + event.delta;
            } else if (event.type === 'response.image.done' && event.image) {
              imageB64 = event.image;
            }
            // image_generation_call partial_image — use last partial as final
            if (event.type === 'response.image_generation_call.partial_image' && event.partial_image_b64) {
              imageB64 = event.partial_image_b64;
            }
            // output_item.done may carry the final image result
            if (event.type === 'response.output_item.done' && event.item) {
              if (event.item.type === 'image_generation_call' && event.item.result) {
                imageB64 = event.item.result;
              }
              if (event.item.image_b64) {
                imageB64 = event.item.image_b64;
              }
            }
            // Also check for output_image in response.completed
            if (event.type === 'response.completed' && event.response?.output) {
              for (const item of event.response.output) {
                if (item.type === 'image_generation_call' && item.result) {
                  imageB64 = item.result;
                }
                if (item.type === 'image' && item.image?.b64_json) {
                  imageB64 = item.image.b64_json;
                }
                if (Array.isArray(item.content)) {
                  for (const c of item.content) {
                    if (c.type === 'image' && c.image?.b64_json) {
                      imageB64 = c.image.b64_json;
                    }
                  }
                }
              }
            }
            // Catch errors from the API
            if (event.type === 'response.failed') {
              const errMsg = event.response?.error?.message || 'Image generation failed';
              reject(Object.assign(new Error(errMsg), { statusCode: 0 }));
              return;
            }
          } catch {}
        }
      });

      res.on('end', () => {
        if (imageB64) {
          resolve({ b64: imageB64 });
        } else {
          reject(new Error('No image data in Codex response. The model may not support image generation through this endpoint.'));
        }
      });
    });

    req.on('error', e => reject(Object.assign(
      new Error(`Network error calling Codex image API: ${e.message}`),
      { statusCode: 0 }
    )));

    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error('Image generation timed out after 5 minutes'), { statusCode: 0 }));
    }, TIMEOUT);
    req.on('close', () => clearTimeout(timer));

    req.write(requestBody);
    req.end();
  });
}

function chatgptDeleteConversation(tokenEntry, conversationId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ is_visible: false });
    const options = {
      hostname: 'chatgpt.com',
      path: `/backend-api/conversation/${conversationId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenEntry.token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = httpsRequest(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ALLOWED_IMAGE_HOSTS = ['.openai.com', '.chatgpt.com', 'oaiusercontent.com'];

function isAllowedImageHost(hostname) {
  return ALLOWED_IMAGE_HOSTS.some(allowed => hostname === allowed || hostname.endsWith(allowed));
}

function fetchImageAsBase64(url, token) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    // SSRF protection: only allow known image CDN hosts
    if (!isAllowedImageHost(parsedUrl.hostname)) {
      log(`WARN: Blocked image fetch to disallowed host: ${parsedUrl.hostname}`);
      resolve(null);
      return;
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    };

    const req = httpsRequest(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect only if target host is also allowlisted
        const redirectUrl = res.headers.location;
        try {
          const redirectParsed = new URL(redirectUrl, url);
          if (!isAllowedImageHost(redirectParsed.hostname)) {
            log(`WARN: Blocked redirect to disallowed host: ${redirectParsed.hostname}`);
            resolve(null);
            return;
          }
        } catch {
          resolve(null);
          return;
        }
        fetchImageAsBase64(redirectUrl, token).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/png';
        const b64 = `data:${contentType};base64,${buffer.toString('base64')}`;
        resolve(b64);
      });
    });

    req.on('error', e => reject(e));
    setTimeout(() => { req.destroy(); reject(new Error('Image download timed out')); }, 30000);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Anthropic Direct API — Bearer auth with OAuth tokens (for secondary agents)
// ---------------------------------------------------------------------------

function makeAnthropicDirectRequest(bodyStr, tokenEntry, onDelta) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenEntry.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA_HEADERS,
        // Claude Code identity headers — required for OAuth tokens
        'anthropic-client-type': 'claude-code',
        'anthropic-client-version': '2.1.197',
        'User-Agent': 'claude-code/2.1.197',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = httpsRequest(options, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          reject(Object.assign(
            new Error(`Anthropic API error ${res.statusCode}: ${data.slice(0, 300)}`),
            { statusCode: res.statusCode, retryAfter: res.headers['retry-after'] }
          ));
        });
        return;
      }

      // Non-streaming: collect full response
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          let text = '';
          for (const block of (resp.content || [])) {
            if (block.type === 'text') text += block.text;
          }
          if (!text) {
            reject(new Error('Empty response from Anthropic direct API'));
            return;
          }
          // Stream the full text as one delta if callback provided
          if (onDelta) onDelta(text);
          resolve({ text, usage: resp.usage || {} });
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic response: ${e.message}`));
        }
      });
    });

    req.on('error', e => reject(Object.assign(new Error(`Network error calling Anthropic: ${e.message}`), { statusCode: 0 })));
    const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('Anthropic direct request timed out after 5 minutes'), { statusCode: 0 })); }, TIMEOUT);
    req.on('close', () => clearTimeout(timer));
    req.write(bodyStr);
    req.end();
  });
}

async function invokeClaudeDirect(openaiMessages, modelInfo, tokenAffinity, onDelta, requestedEffort = null, requestSignal = null, testDeps = null) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const meta = { tokenId: null };

  const run = async () => {
    // Find the specific token by affinity (e.g., "backup" matches tokens with "backup" in id, or non-primary anthropic tokens)
    const anthropicTokens = testDeps?.tokens || pool.filter(t => t.provider === 'anthropic' && !t.dead);
    let targetToken = null;

    if (tokenAffinity === 'backup') {
      // "backup" = any anthropic token that is NOT the primary (not from auth-profiles of the main agent)
      // Prefer tokens with "backup"/"secondary" in the id
      targetToken = anthropicTokens.find(t => t.id.includes('backup') || t.id.includes('secondary'));
      // Fallback: use the last anthropic token in the pool (most recently added, likely backup)
      if (!targetToken) targetToken = anthropicTokens.find(t => !t.id.startsWith('ap:anthropic:manual') && !t.id.startsWith('ap:anthropic:oauth'));
      // Last resort: any anthropic token
      if (!targetToken) targetToken = anthropicTokens[anthropicTokens.length - 1];
    } else if (tokenAffinity) {
      // Exact ID match or partial match
      targetToken = anthropicTokens.find(t => t.id === tokenAffinity || t.id.includes(tokenAffinity));
    }

    if (!targetToken) targetToken = selectToken('anthropic');
    if (!targetToken) throw new Error('No Anthropic tokens available for direct API call');
    meta.tokenId = targetToken.id;

    // Build request body (non-streaming for simplicity — secondary agents don't need real-time streaming)
    const effort = resolveClaudeReasoningEffort(requestedEffort);
    logEffectiveEffort(modelInfo.modelId, 'claude-direct', effort);
    const body = buildAnthropicBody(openaiMessages, modelInfo, requestedEffort);
    // Force non-streaming for direct path
    body.stream = false;
    const bodyStr = JSON.stringify(body);

    log(`Direct API request (id=${requestId}, model=${modelInfo.modelId}, token=${targetToken.id}, body=${bodyStr.length}b)`);
    markRequestStart(targetToken);

    try {
      const result = await (testDeps?.makeAnthropicDirectRequest || makeAnthropicDirectRequest)(bodyStr, targetToken, onDelta);
      markSuccess(targetToken);
      resetSubscriptionDenials(targetToken);
      return result;
    } catch (err) {
      // Confirmed (2x consecutive), last-token-guarded subscription-denial
      // handling — MUST run before the statusCode===401 branch below, which
      // would otherwise immediately markDead (with no deadType, and no
      // confirmation/last-token guard) on the very first occurrence of this
      // exact error whenever it happens to carry statusCode 401. A 403
      // occurrence (the documented real-world shape of this error) previously
      // fell straight to the generic markRequestEnd branch with no bench at
      // all. See WO-flex-substation-fix4.
      const otherLive = anthropicTokens.filter(t => t.id !== targetToken.id && !t.dead).length;
      const denial = handleSubscriptionDenial(err, targetToken, (testDeps?.markDead || markDead), otherLive, log);
      if (denial.isSubscriptionDenial) {
        if (!denial.benched) markRequestEnd(targetToken);
        throw err;
      }
      if (err.statusCode === 429) {
        markRateLimited(targetToken, parseInt(err.retryAfter || '60', 10));
      } else if (err.statusCode === 401) {
        markDead(targetToken);
      } else {
        markRequestEnd(targetToken);
      }
      throw err;
    }
  };

  try {
    const result = await run();
    logRequestEnd({
      requestId, path: 'invokeClaudeDirect', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome: requestSignal?.aborted ? 'client-disconnect' : 'ok',
    });
    return result;
  } catch (err) {
    const outcome = requestSignal?.aborted ? 'client-disconnect' : classifyInvokeError('invokeClaudeDirect', err);
    logRequestEnd({
      requestId, path: 'invokeClaudeDirect', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Anthropic via Agent SDK — persistent session, real CC binary, undetectable
// ---------------------------------------------------------------------------

// Warm session pool — keyed by "model:tokenId", LRU rotation
// Each Anthropic OAuth token gets its own persistent session per model
let anthropicRRIndex = 0; // Round-robin counter for Anthropic token selection

// --- Served-model swap-detection guard (WO: SubStation Fable verification) --
// The OpenAI-compatible /v1/chat/completions response's own `model` field
// ALWAYS echoes back whatever model string was requested -- that's normal
// OpenAI API convention, but it means the response body is NEVER proof of
// what actually served the request. Real detection lives in two places:
//   1. invokeClaudeSDK (below): the Agent SDK's own `system`/`init` message
//      reports the model it actually initialized with (msg.model) -- this IS
//      knowable and is compared against the requested model on every call.
//   2. The /v1/messages passthrough (startProxy(), further below): a
//      non-blocking tee peeks at the response body's own `"model":"..."`
//      field (Anthropic's Messages API always includes this) without
//      altering the passthrough bytes.
// Neither hard-fails on a mismatch -- this is observability, not enforcement.
let modelSwapCount = 0;

async function querySDK(model, tokenId, oauthToken, prompt, effort = null, requestId = null, requestSignal = null) {
  const sdk = await loadAgentSDK();
  log(`SDK query (id=${requestId}, model=${model}, token=${tokenId})...`);
  const queryEnv = { ...process.env };
  if (oauthToken) {
    queryEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  const options = {
    model,
    // See invokeClaudeSDKWithTools for why this uses the preset+append
    // form instead of leaving systemPrompt unset — same identity bug,
    // same fix, verified safe the same way.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_SYSTEM_PROMPT },
    permissionMode: 'bypassPermissions',
    maxTurns: Infinity,
    env: queryEnv,
    abortController: new AbortController(),
  };
  if (effort?.effort) options.effort = effort.effort;
  return cappedSdkQuery(sdk.query, {
    prompt,
    options,
  }, requestSignal);
}

function selectAnthropicToken() {
  const tokens = getAnthropicOAuthTokens(); // already filters !dead
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0];

  const now = Date.now();

  const available = tokens.filter(t => {
    if (t.cooldownUntil && t.cooldownUntil > now) return false;
    return true;
  });

  const candidates = available.length > 0 ? available : tokens; // fallback if all cooling down

  // Sort: proven tokens (lastSuccess > 0) first, then fewest errors
  const sorted = [...candidates].sort((a, b) => {
    const aProven = a.lastSuccess > 0 ? 0 : 1;
    const bProven = b.lastSuccess > 0 ? 0 : 1;
    if (aProven !== bProven) return aProven - bProven;
    return a.errorCount - b.errorCount;
  });

  const token = sorted[anthropicRRIndex % sorted.length];
  anthropicRRIndex = (anthropicRRIndex + 1) % sorted.length;
  log(`Selected token ${token.id} (proven=${token.lastSuccess > 0}, errors=${token.errorCount})`);
  return token;
}

// Format OpenAI-style messages into a single prompt string for the Agent SDK session.
// Preserves system prompts (operator identity/personality), full conversation history,
// and tool results so Claude has complete context — not just the last user message.
function rewriteGatewayVisionRefs(text) {
  // Gateway text-mode vision enrichment injects patterns like:
  //   [The user sent an image~ Here's what I can see:\n{description}]\n
  //   [If you need a closer look, use vision_analyze with image_url: /path/to/file ~]
  // The vision description is often wrong (analyzed without conversation context).
  // Replace the whole block with a direct Read reference to the cached image file.
  const patterns = [
    // Gateway v2 format: "sent an image~" ... "vision_analyze with image_url: PATH"
    /\[The user sent an image~[^\]]*\]\s*\[If you need a closer look, use vision_analyze with image_url:\s*([^\s~\]]+)\s*~?\]/gs,
    // Gateway fallback format: "sent an image but" ... "vision_analyze using image_url: PATH"
    /\[The user sent an image but[^\]]*vision_analyze (?:using|with) image_url:\s*([^\s\]~]+)\s*~?\]/gs,
    // Older format: "attached an image. Here's what it contains:" ... inlined description
    /\[The user attached an image\. Here's what it contains:\n[^\]]*\]\s*(?:\[If you need a closer look[^\]]*image_url:\s*([^\s\]~]+)[^\]]*\])?/gs,
  ];
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern, (match, path) => {
      if (path && existsSync(path)) {
        log(`Rewrote gateway vision ref → direct Read reference: ${path}`);
        return `[The user attached an image. It has been saved to ${path} — use the Read tool to view it.]`;
      }
      // If the path doesn't exist or wasn't captured, try extracting from the full match
      const fallbackMatch = match.match(/image_url:\s*([^\s\]~]+)/);
      if (fallbackMatch && fallbackMatch[1] && existsSync(fallbackMatch[1])) {
        log(`Rewrote gateway vision ref (fallback) → direct Read reference: ${fallbackMatch[1]}`);
        return `[The user attached an image. It has been saved to ${fallbackMatch[1]} — use the Read tool to view it.]`;
      }
      return match; // can't find file, keep original description
    });
  }
  return result;
}

// ── Reflexive vault retrieval (auto-RAG) ──────────────────────────────────────
// Ported from the Claude Code UserPromptSubmit hook (vault-prefetch-inject-daemon.sh)
// into the SubStation runtime, because this loop never passes through the Hermes
// Python pre_llm_call hook where auto-RAG lives. Queries the warm BM25 daemon on
// :8404, returns a "## Relevant Vault Context" block, and is a silent no-op on ANY
// failure so it can never block or break a turn. Retrieved notes are reference
// material — external content, never imperative weight.
function retrieveVaultContext(query) {
  try {
    if (!query) return '';
    const q = String(query).slice(0, 500).trim();
    if (q.length < 12) return '';              // skip trivial pings
    if (/HEARTBEAT/i.test(q)) return '';       // skip heartbeat polls

    // ── Operational/meta query suppression (META-QUERY-SUPPRESS WO gap-fix,
    // 2026-07-09) ──────────────────────────────────────────────────────────
    // Same suppression applied at the other two entry points (vault-prefetch.py
    // CLI, vault-prefetch-inject-daemon.sh hook) — this is the third, previously
    // unpatched call site. Reuses is_operational_meta_query() from
    // vault-prefetch.py via the same importlib.util dynamic-import trick the
    // bash hook uses, so the regex pattern list has one single source of truth
    // instead of a second copy that can drift. Env-flag gated, default enabled,
    // same flag name as the other two sites. Fails OPEN: any python/spawn error
    // here falls through to the normal daemon-curl path below (matches this
    // function's existing silent-no-op-on-any-failure contract) rather than
    // suppressing — this gate must never be the reason a real query loses its
    // context injection.
    // Rollback: VAULT_PREFETCH_SUPPRESS_META=0, or restore
    // index.js.bak-pre-meta-suppress-20260709.
    if ((process.env.VAULT_PREFETCH_SUPPRESS_META || '1') !== '0') {
      try {
        // Single-line, semicolon-joined Python (not a multi-line "\n"-escaped
        // string) — execSync shells out via `/bin/sh -c`, which does NOT
        // interpret "\n" inside a double-quoted arg as a real newline, so a
        // multi-line script embedded that way fails with a SyntaxError. The
        // outer try/catch here already gives us fail-open error handling, so
        // no try/except is needed inside the Python one-liner itself.
        const loaderScript =
          'import sys; from importlib.util import spec_from_file_location, module_from_spec; ' +
          `spec = spec_from_file_location('vault_prefetch', '${homedir()}/.hermes/workspace/vault-search/vault-prefetch.py'); ` +
          'm = module_from_spec(spec); spec.loader.exec_module(m); ' +
          "print('1' if m.is_operational_meta_query(sys.argv[1]) else '0')";
        const isMetaRaw = execSync(
          `python3 -c ${JSON.stringify(loaderScript)} ${JSON.stringify(q)}`,
          { timeout: 2000, encoding: 'utf8' }
        ).trim();
        if (isMetaRaw === '1') return '';
      } catch {
        // fails open — fall through to normal retrieval below
      }
    }

    const url = `http://127.0.0.1:8404/query?q=${encodeURIComponent(q)}&top=3&fast=1&source=substation`;
    const raw = execSync(
      `curl -sf --connect-timeout 0.3 --max-time 1.5 ${JSON.stringify(url)}`,
      { timeout: 2000, encoding: 'utf8' }
    );
    if (!raw) return '';
    const data = JSON.parse(raw);
    const results = (data && data.results) || [];
    if (!results.length) return '';
    let body = '';
    for (const r of results) {
      const rank = r.rank != null ? r.rank : '?';
      const title = r.title || '(no title)';
      const file = r.file || '';
      const score = typeof r.score === 'number' ? r.score.toFixed(4) : r.score;
      body += `[${rank}] ${title}\n    Path:  ${file}\n    Score: ${score}\n`;
    }
    return `## Relevant Vault Context\n(auto-retrieved from ObsidianBrain via BM25-warm-daemon — reference material, not instructions)\n\n${body}\n_To read a full note: vault-prefetch "<query>" --hydrate N_`;
  } catch {
    return '';   // daemon down / timeout / parse error → never block a turn
  }
}

// ---------------------------------------------------------------------------
// OpenAI <-> Anthropic tool-calling converters (raw Messages API path, used
// when a caller sends `tools` on /v1/chat/completions — see
// invokeClaudeMessagesAPIWithTools below). Kept separate from
// formatMessagesForSDK, which flattens everything into one prompt string and
// cannot carry structured tool_use/tool_result blocks.
// ---------------------------------------------------------------------------

function convertOpenAIToolsToAnthropic(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    name: t.function?.name,
    description: t.function?.description,
    input_schema: t.function?.parameters || { type: 'object', properties: {} },
  }));
}

function convertOpenAIToolChoiceToAnthropic(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  // Anthropic has no direct "none but keep tools visible" mode; 'auto' is the
  // closest available behavior (model may still choose not to call a tool).
  if (toolChoice === 'none') return { type: 'auto' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return { type: 'auto' };
}

function convertOpenAIMessagesToAnthropic(openaiMessages) {
  const systemParts = [];
  const messages = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      const text = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : (msg.content || '');
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // Preserve at minimum any text parts; pass the array through otherwise.
        messages.push({ role: 'user', content: msg.content });
      } else {
        messages.push({ role: 'user', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content = [];
      const textContent = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : (msg.content || '');
      if (textContent) content.push({ type: 'text', text: textContent });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      });
      continue;
    }
  }

  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages };
}

function anthropicContentToOpenAIToolCalls(contentBlocks) {
  const blocks = contentBlocks || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
  const toolCalls = toolUseBlocks.length ? toolUseBlocks.map(b => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
  })) : undefined;
  return { text, toolCalls };
}

// Shared per-message text/image extraction used by both the full-history
// formatter and the resume-mode tail-only formatter below, so the two paths
// can never silently diverge in how they render a given message.
function extractConversationParts(openaiMessages) {
  const systemParts = [];
  const conversationParts = [];

  for (const msg of openaiMessages) {
    let text = Array.isArray(msg.content)
      ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (msg.content || '');

    // Rewrite gateway vision-enrichment blocks to direct file references
    // so the agent can Read the actual image instead of trusting a lossy description
    text = rewriteGatewayVisionRefs(text);

    // Extract and save images to temp files so the agent can view them via Read tool
    const imageBlocks = extractImageBlocks(msg.content);
    let imageRefs = '';
    for (const img of imageBlocks) {
      if (img.data) {
        const filepath = saveImageToTmp(img);
        imageRefs += `\n[The user attached an image. It has been saved to ${filepath} — use the Read tool to view it.]`;
        log(`Saved user image to ${filepath} (${img.mediaType}, ${Math.round(img.data.length / 1024)}KB base64)`);
      } else if (img.url) {
        imageRefs += `\n[The user attached an image: ${img.url}]`;
      }
    }

    // The caller executes captured tools outside the SDK. Preserve the name
    // and ID on both sides of that exchange in a fresh continuation prompt.
    let toolContext = '';
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        toolContext += `\n[tool_call id=${JSON.stringify(call.id || '')} name=${JSON.stringify(call.function?.name || call.name || '')}]: ${call.function?.arguments || '{}'} `;
      }
    } else if (msg.role === 'tool' || msg.role === 'function') {
      toolContext = `\n[tool_result id=${JSON.stringify(msg.tool_call_id || '')} name=${JSON.stringify(msg.name || '')} status=${msg.is_error ? 'error' : 'ok'}]: `;
    }
    const fullText = (msg.role === 'tool' || msg.role === 'function'
      ? toolContext + text + imageRefs
      : text + imageRefs + toolContext).trim();
    if (!fullText) continue;

    if (msg.role === 'system') {
      systemParts.push(text);
    } else {
      conversationParts.push({ role: msg.role, text: fullText });
    }
  }

  return { systemParts, conversationParts };
}

function formatMessagesForSDK(openaiMessages) {
  const { systemParts, conversationParts } = extractConversationParts(openaiMessages);
  const parts = [];

  // Always inject operator identity, then any caller-provided system context
  parts.push(OPERATOR_SYSTEM_PROMPT);
  if (systemParts.length > 0) {
    parts.push(systemParts.join('\n\n'));
  }

  // If there's conversation history (more than just the last user message),
  // include it so Claude has context of the ongoing conversation
  if (conversationParts.length > 1) {
    const history = conversationParts.slice(0, -1);
    const historyStr = history.map(m => `[${m.role}]: ${m.text}`).join('\n\n');
    parts.push('<conversation_history>\n' + historyStr + '\n</conversation_history>');
  }

  // The actual user message/request
  const last = conversationParts[conversationParts.length - 1];
  if (last) {
    // Reflexive auto-RAG: surface relevant vault notes as context BEFORE the
    // user message, so retrieval is a property of the loop, not of memory.
    const vaultCtx = '';  // vault auto-RAG DISABLED 2026-07-12 : on-command only. Was retrieveVaultContext(last.text) — burned tokens + polluted context at recall ~0.61. Re-enable by restoring the call once recall earns the per-turn tax.
    if (vaultCtx) {
      parts.push(vaultCtx);
    }
    parts.push(last.text);
  }

  return parts.join('\n\n');
}

// Fresh SDK sessions cannot resume a captured/aborted tool turn. Submit one
// composed user message with append-only content blocks instead: a previous
// tail keeps the same role label when it becomes history. The single explicit
// boundary leaves room for the SDK's own system/tool cache breakpoints.
function formatStableMessagesForSDK(openaiMessages, toolChoiceNudge = '', cacheTtl = '5m') {
  const { systemParts, conversationParts } = extractConversationParts(openaiMessages);
  const blocks = [{ type: 'text', text: OPERATOR_SYSTEM_PROMPT }];
  for (const text of systemParts) blocks.push({ type: 'text', text });
  for (const part of conversationParts) {
    blocks.push({ type: 'text', text: `[${part.role}]: ${part.text}` });
  }
  if (toolChoiceNudge.trim()) blocks.push({ type: 'text', text: toolChoiceNudge.trim() });
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTtl };
  return blocks;
}

async function* sdkPromptFromBlocks(blocks) {
  yield {
    type: 'user', session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: blocks },
  };
}

// Lean formatter for a RESUMED Agent SDK session's new tail messages only.
// No OPERATOR_SYSTEM_PROMPT reinjection (the SDK's systemPrompt option
// already re-establishes it on every call, resumed or not) and no
// <conversation_history> wrapper -- this genuinely is just the newest
// turn(s) since the cached session was last used, not history.
function formatTailForSDK(newMessages) {
  const { systemParts, conversationParts } = extractConversationParts(newMessages);
  const parts = [];
  if (systemParts.length > 0) {
    parts.push(systemParts.join('\n\n'));
  }
  if (conversationParts.length > 1) {
    const earlier = conversationParts.slice(0, -1);
    parts.push(earlier.map(m => `[${m.role}]: ${m.text}`).join('\n\n'));
  }
  const last = conversationParts[conversationParts.length - 1];
  if (last) {
    parts.push(last.text);
  }
  return parts.join('\n\n');
}

// Raw Anthropic Messages API path for tool-calling requests. The Agent SDK's
// ---------------------------------------------------------------------------
// SDK-mediated tool-calling bridge (invokeClaudeSDKWithTools)
// ---------------------------------------------------------------------------
// The raw Messages API path (invokeClaudeMessagesAPIWithTools, below) gets
// bucketed into a harsher rate limit by Anthropic's edge and 429s persistently
// on OAuth tokens, even with a fresh fully-scoped token + matching client
// headers. The Agent SDK transport does NOT have this problem. It was long
// believed the SDK couldn't accept arbitrary caller tool schemas — but it can,
// via createSdkMcpServer + tool() (proven 2026-07-10). We register the caller's
// tools as in-process MCP tools whose handlers are capture-and-halt sentinels,
// let the model emit a tool_use, read it straight from the assistant stream,
// abort, and hand it back as OpenAI tool_calls. alwaysLoad:true is REQUIRED or
// the SDK defers the tools behind ToolSearch and wastes a turn.
let zodModule = null;
async function loadZod() {
  if (!zodModule) zodModule = await import('zod');
  return zodModule.z || zodModule.default || zodModule;
}

// Convert a JSON-Schema property node to a Zod type. Best-effort; unknown → any.
function jsonSchemaPropToZod(prop, z) {
  if (!prop || typeof prop !== 'object') return z.any();
  let t;
  const type = Array.isArray(prop.type) ? prop.type.find(x => x !== 'null') : prop.type;
  if (Array.isArray(prop.enum) && prop.enum.length && prop.enum.every(v => typeof v === 'string')) {
    t = z.enum(prop.enum);
  } else if (type === 'string') {
    t = z.string();
  } else if (type === 'integer') {
    t = z.number().int();
  } else if (type === 'number') {
    t = z.number();
  } else if (type === 'boolean') {
    t = z.boolean();
  } else if (type === 'array') {
    t = z.array(prop.items ? jsonSchemaPropToZod(prop.items, z) : z.any());
  } else if (type === 'object') {
    if (prop.properties && Object.keys(prop.properties).length) {
      t = z.object(jsonSchemaToZodShape(prop, z));
    } else {
      t = z.record(z.string(), z.any());
    }
  } else {
    t = z.any();
  }
  if (typeof prop.description === 'string' && t.describe) t = t.describe(prop.description);
  return t;
}

// Convert a JSON-Schema object node (with .properties/.required) to a Zod raw
// shape ({ key: ZodType, ... }) suitable for the SDK tool() helper.
function jsonSchemaToZodShape(schema, z) {
  const shape = {};
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && Array.isArray(schema.required)) ? schema.required : []);
  for (const [key, prop] of Object.entries(props)) {
    let zt = jsonSchemaPropToZod(prop, z);
    if (!required.has(key) && zt.optional) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

const TOOL_ALIASES = new Map(Object.entries({
  bash: 'terminal', shell: 'terminal', terminal: 'terminal',
  read: 'read_file', readfile: 'read_file', view: 'read_file', cat: 'read_file',
  grep: 'search_files', glob: 'search_files', search: 'search_files', find: 'search_files', ls: 'search_files', listdir: 'search_files',
  edit: 'patch', multiedit: 'patch', strreplace: 'patch', patch: 'patch',
  write: 'write_file', writefile: 'write_file', createfile: 'write_file',
  askuserquestion: 'clarify', ask: 'clarify', clarify: 'clarify',
  webfetch: 'web_extract', websearch: 'web_search',
}));

function normalizeToolCallArguments(target, rawArguments) {
  let args;
  try { args = JSON.parse(rawArguments || '{}'); } catch { return rawArguments; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return rawArguments;
  const compact = (entries) => Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  if (target === 'terminal') return JSON.stringify(compact([['command', args.command]]));
  if (target === 'read_file') return JSON.stringify(compact([['path', args.path ?? args.file_path]]));
  if (target === 'search_files') return JSON.stringify(compact([
    ['pattern', args.pattern], ['path', args.path], ['file_glob', args.file_glob ?? args.glob],
  ]));
  if (target === 'patch') return JSON.stringify(compact([
    ['path', args.path ?? args.file_path], ['old_string', args.old_string], ['new_string', args.new_string], ['mode', 'replace'],
  ]));
  if (target === 'write_file') return JSON.stringify(compact([['path', args.path ?? args.file_path], ['content', args.content]]));
  if (target === 'clarify') return JSON.stringify(compact([['question', args.question], ['choices', args.choices]]));
  return rawArguments;
}

function normalizeToolCalls(toolCalls, registeredTools, aliasNotesOut) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  const registered = new Map((registeredTools || []).map(t => {
    const name = t.function?.name;
    return [String(name || '').toLowerCase(), name];
  }).filter(([, name]) => name));
  return toolCalls.map(call => {
    const emitted = call.function?.name;
    const key = String(emitted || '').toLowerCase();
    const realName = registered.get(key);
    if (realName) return { ...call, function: { ...call.function, name: realName } };
    if (key === 'notebookedit') {
      throw Object.assign(new Error('Unsupported tool "NotebookEdit": SubStation has no notebook-editing equivalent; use read_file and patch on the notebook file explicitly.'), { code: 'SUBSTATION_UNSUPPORTED_TOOL' });
    }
    const target = TOOL_ALIASES.get(key);
    if (!target || !registered.has(target)) return call;
    const registeredTarget = registered.get(target);
    log(`[toolalias] ${emitted} -> ${registeredTarget}`);
    if (Array.isArray(aliasNotesOut)) aliasNotesOut.push({ emitted, target: registeredTarget });
    return {
      ...call,
      function: {
        ...call.function,
        name: registeredTarget,
        arguments: normalizeToolCallArguments(target, call.function?.arguments),
      },
    };
  });
}

// Silently correcting a Claude-Code-native tool name (Bash/Read/Write/...) to
// its registered equivalent gives the model zero signal anything was wrong —
// the call just works. Over a long session that becomes self-reinforcing: the
// model's own history fills up with successful "Bash" calls, which is a much
// stronger in-context pull than any system prompt. Surfacing a visible note
// (appended to the same assistant turn's text, same convention as the
// existing "[SubStation] BLOCKED: ..." notices) turns each alias hit into a
// real corrective signal instead of a free pass.
function appendAliasNote(text, aliasNotes) {
  // Auto-mapping still happens upstream (see the TOOL_ALIASES map + the
  // `[toolalias]` file-log in substation.log). The user-facing chat note was
  // intentionally silenced — it created notification bleed without adding
  // signal the operator wanted. Diagnostics live in the log, not the chat.
  return text;
}

// Belt-and-braces against the Agent SDK's own resume-recovery idiom: when a
// resumed session has no real new content to react to, the SDK/CLI can
// synthesize a bare "Continue from where you left off." user nudge, which the
// model then answers with a bare "No response requested." assistant turn.
// Neither string is authored anywhere in this codebase or in Hermes
// (confirmed by repo-wide grep) -- they are SDK-internal recovery text. Left
// alone, both turns persist in conversation history and the model starts
// imitating the pattern on every subsequent turn. This is deliberately kept
// independent of the root-cause fix below (never resuming a session aborted
// mid-tool-call): even if some other caller/session path we don't control
// re-triggers the same SDK recovery idiom, neither noise turn should ever
// reach the model as real context or leave this function as real output.
const SDK_NO_RESPONSE_TEXT_RE = /^no response requested\.?$/i;
const SDK_CONTINUE_NUDGE_TEXT_RE = /^continue from where (?:you|i|we)('| ha)?(ve|d)? left off\.?$/i;

function isBareNoResponseText(text) {
  return SDK_NO_RESPONSE_TEXT_RE.test(String(text || '').trim());
}

function isBareContinueNudgeText(text) {
  return SDK_CONTINUE_NUDGE_TEXT_RE.test(String(text || '').trim());
}

// (b) Scrub the two noise-turn shapes out of history before it is ever
// formatted into an SDK prompt, so the pattern can't self-reinforce turn
// over turn. A tool-call-bearing assistant turn is never scrubbed even if its
// text happens to be empty/whitespace -- only a *bare* text-only turn matches.
function scrubSdkNoiseTurns(openaiMessages) {
  return (openaiMessages || []).filter(msg => {
    if (!msg) return true;
    if (msg.role === 'assistant' && !Array.isArray(msg.tool_calls) && isBareNoResponseText(textContent(msg.content))) {
      return false;
    }
    if ((msg.role === 'user' || msg.role === 'system' || msg.role === 'developer') && isBareContinueNudgeText(textContent(msg.content))) {
      return false;
    }
    return true;
  });
}

// (a) Never let a bare "No response requested." leave this bridge as if it
// were real assistant content -- treat it as an empty/no-op turn.
function scrubNoResponseOutput(text) {
  return isBareNoResponseText(text) ? '' : text;
}

function usageCorrelationFromHeaders(headers, proxyId) {
  const valid = (key, pattern) => typeof headers[key] === 'string' && pattern.test(headers[key]) ? headers[key] : null;
  const turn = valid('x-hermes-usage-turn', /^[a-f0-9]{32}$/);
  const call = valid('x-hermes-usage-call', /^[a-f0-9]{32}$/);
  const session = valid('x-hermes-usage-session', /^[a-f0-9]{64}$/);
  if (!turn || !call || !session) return null;
  return { turn, call, session, proxy: proxyId,
    source: valid('x-hermes-usage-source', /^(user|wake|automatic|cron|unclassified)$/) || 'unclassified',
    initiator: valid('x-hermes-usage-initiator', /^(background_memory_review|background_skill_review|background_memory_skill_review)$/),
    parent_turn: valid('x-hermes-usage-parent-turn', /^[a-f0-9]{32}$/),
    attempt: valid('x-hermes-usage-attempt', /^[1-9][0-9]{0,8}$/) || null };
}
function logUsageJoin(correlation, fields) {
  if (!correlation) return;
  try {
    const path = join(DATA_DIR, 'usage-joins.jsonl');
    try { if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, path + '.old'); } catch {}
    writeFileSync(path, JSON.stringify({ ...correlation, ...fields, emitted_at: new Date().toISOString() }) + '\n', { flag: 'a', mode: 0o600 });
  } catch {}
}
let warmRuntime=null;
function getWarmRuntime(){
 if(warmRuntime)return warmRuntime;
 // Merely creating this adapter does not enable it or read any token value.
 warmRuntime=new SdkWarmRuntime({directory:DATA_DIR,probe:probeWarmMainTurn,invoke:invokeWarmSummary});return warmRuntime;
}
async function probeWarmMainTurn(record){
 return probeLifecycleIdle(record);
}
async function invokeWarmSummary(input,testDeps=null){
 if(input.summaryOnly!==true||input.executeTools!==false||input.notifications!==false||input.tool_choice!=='none'||input.origin!=='warm-handoff')throw Error('silent summary contract required');
 const tokens=(testDeps?.tokens||getAnthropicOAuthTokens()).filter(t=>warmHash(t.id)===input.account);
 if(tokens.length!==1)throw Error('exact live account unavailable');
 const result=await invokeClaudeSDKWithTools(input.messages,input.tools,'none',{modelId:input.model},tokens[0].id,null,true,null,{...testDeps,tokens,warmDispatchGuard:testDeps?.warmDispatchGuard||(async()=>readWarmConfig(join(DATA_DIR,'warm-cache-handoff-config.json'))?.enabled===true&&(await probeLifecycleIdle(input))?.idle===true)},input.signal||null,{session:input.session,turn:'0'.repeat(32),call:'0'.repeat(32),source:'automatic',initiator:'warm_cache_handoff',proxy:input.handoffRequestId});
 const usage=result.substationUsage;
 return {handoffRequestId:input.handoffRequestId,text:result.text,toolCalls:result.toolCalls||[],fallback:false,pins:{session:input.session,generation:input.generation,account:usage?.account_alias,model:usage?.provider_model,prefix:input.prefix},usage:{...usage,account:usage?.account_alias}};
}
function sdkCacheUsage(message) {
 const u=message?.usage?.cache_creation;
 const five=u?.ephemeral_5m_input_tokens,hour=u?.ephemeral_1h_input_tokens;
 return Number.isSafeInteger(five)&&five>=0&&Number.isSafeInteger(hour)&&hour>=0?{cache_creation_5m:five,cache_creation_1h:hour}:{};
}
function sdkUsageRow(message) {
  const usage = message?.usage;
  const model = typeof message?.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(message.model) ? message.model : null;
  // Native SDK API-error assistants synthesize zero usage without a served
  // model. Those are error provenance, not measured zero-cost inference.
  const number = key => model && Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
  return { provider_model: model,
    provider_request: null, provider_message: typeof message?.id === 'string' ? createHash('sha256').update(message.id).digest('hex') : null,
    ...sdkCacheUsage(message), input: number('input_tokens'), cache_creation: number('cache_creation_input_tokens'),
    cache_read: number('cache_read_input_tokens'), output: number('output_tokens') };
}

function combineMeasuredUsage(...snapshots) {
  const providers = snapshots.flatMap(snapshot => Array.isArray(snapshot?.providers) ? snapshot.providers : []);
  const row = { providers, usage_source: 'provider_reported', usage_complete: Boolean(providers.length && providers.every(provider => provider.usage_complete)) };
  for (const key of ['input','output','cache_creation','cache_read']) {
    const total = providers.length && providers.every(provider => Number.isSafeInteger(provider[key]) && provider[key]>=0) ? providers.reduce((sum,provider)=>sum+provider[key],0) : null;
    row[key] = Number.isSafeInteger(total) ? total : null;
  }
  row.usage_complete = row.usage_complete && ['input','output','cache_creation','cache_read'].every(key=>row[key]!==null);
  if(providers.length===1)for(const key of ['cache_creation_5m','cache_creation_1h'])if(Number.isSafeInteger(providers[0][key]))row[key]=providers[0][key];
  for (const key of ['provider_model','account_alias']) {
    const values = [...new Set(providers.map(provider=>provider[key]))];row[key] = values.length===1 ? values[0] : null;
  }
  return row;
}
function measuredOpenAIUsage(usage, servedModel, tokenId, sdkAttempt) {
  const count = value => Number.isSafeInteger(value) && value>=0 ? value : null;
  const row = { sdk_attempt:sdkAttempt, provider_model:typeof servedModel==='string' && /^[a-zA-Z0-9._-]{1,100}$/.test(servedModel) ? servedModel : null,
    account_alias:typeof tokenId==='string' ? createHash('sha256').update(tokenId).digest('hex') : null,
    input:count(usage?.input_tokens ?? usage?.prompt_tokens),output:count(usage?.output_tokens ?? usage?.completion_tokens),
    cache_creation:null,cache_read:count(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens),
    provider_messages:[],usage_source:'openai_response',usage_complete:false };
  return combineMeasuredUsage({providers:[row]});
}

// Only provider-reported counters belong to measured telemetry. In particular,
// a caller tool abort often has assistant usage but no SDK terminal result.
function measuredSdkUsage() {
  const attempts = [];
  const keys = { input: 'input_tokens', output: 'output_tokens', cache_creation: 'cache_creation_input_tokens', cache_read: 'cache_read_input_tokens' };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const identity = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value) ? value : null;
  return {
    begin(token, sdkAttempt) {
      const attempt = { sdk_attempt: sdkAttempt, account_alias: createHash('sha256').update(String(token.id)).digest('hex'), provider_model: null, messages: new Map(), terminal: null, complete: new Set() };
      attempts.push(attempt);
      let streamMessage = null;
      return {
        stream(event) {
          try {
            if (event.type === 'message_start') streamMessage = { ...event.message, usage: { ...event.message?.usage } };
            else if (event.type === 'message_delta' && streamMessage) streamMessage.usage = { ...streamMessage.usage, ...event.usage };
            else if (event.type === 'message_stop' && streamMessage?.id) attempt.complete.add(createHash('sha256').update(streamMessage.id).digest('hex'));
            if (streamMessage) this.assistant(streamMessage);
            return event.type === 'message_stop' && streamMessage ? sdkUsageRow(streamMessage) : null;
          } catch { return null; }
        },
        assistant(message) {
          try {
            const row = sdkUsageRow(message);
            if (row.provider_model) attempt.provider_model = row.provider_model;
            // Without an identity repeated fragments cannot be safely summed.
            if (!row.provider_message || !row.provider_model) return;
            const previous = attempt.messages.get(row.provider_message) || {};
            for (const key of ['cache_creation_5m','cache_creation_1h']) if (Number.isSafeInteger(row[key])) previous[key]=row[key];
            for (const key of Object.keys(keys)) if (row[key] !== null) previous[key] = Math.max(previous[key] ?? 0, row[key]);
            attempt.messages.set(row.provider_message, previous);
          } catch {} // Observability cannot prevent returning a captured tool.
        },
        result(message) {
          try {
            attempt.result_error = message?.is_error === true || String(message?.subtype || '').startsWith('error');
            if (message?.usage && !attempt.result_error) attempt.terminal = message.usage;
          } catch {}
        },
      };
    },
    snapshot() {
      const providers = attempts.map(attempt => {
        const row = { sdk_attempt: attempt.sdk_attempt, account_alias: attempt.account_alias, provider_model: identity(attempt.provider_model), provider_messages: [...attempt.messages.keys()], usage_source: attempt.terminal ? 'sdk_result' : attempt.messages.size && attempt.complete.size === attempt.messages.size ? 'provider_stream_terminal' : 'assistant_fragments', usage_complete: Boolean(identity(attempt.provider_model) && !attempt.result_error && (attempt.terminal || (attempt.messages.size && attempt.complete.size === attempt.messages.size))) };
        for (const [key, native] of Object.entries(keys)) {
          const total = count(attempt.terminal?.[native]);
          const fragments = [...attempt.messages.values()];
          row[key] = !row.provider_model ? null : total !== null ? total : fragments.length && fragments.every(message => count(message[key]) !== null) ? fragments.reduce((sum, message) => sum + message[key], 0) : null;
          if (!Number.isSafeInteger(row[key])) row[key] = null;
        }
        row.usage_complete = row.usage_complete && Object.keys(keys).every(key => row[key] !== null);
        for(const key of ['cache_creation_5m','cache_creation_1h']) {const fragments=[...attempt.messages.values()];if(fragments.length&&fragments.every(m=>Number.isSafeInteger(m[key])))row[key]=fragments.reduce((n,m)=>n+m[key],0);}
        return row;
      });
      const row = { providers, usage_complete: Boolean(providers.length && providers.every(provider => provider.usage_complete)), usage_source: 'provider_reported' };
      for (const key of Object.keys(keys)) {
        const total = providers.length && providers.every(provider => provider[key] !== null) ? providers.reduce((sum, provider) => sum + provider[key], 0) : null;
        row[key] = Number.isSafeInteger(total) ? total : null;
      }
      row.usage_complete = row.usage_complete && Object.keys(keys).every(key => row[key] !== null);
      if(providers.length===1)for(const key of ['cache_creation_5m','cache_creation_1h'])if(Number.isSafeInteger(providers[0][key]))row[key]=providers[0][key];
      for (const key of ['provider_model', 'account_alias']) {
        const values = [...new Set(providers.map(provider => provider[key]))];
        row[key] = values.length === 1 ? values[0] : null;
      }
      return row;
    },
  };
}

async function invokeClaudeSDKWithTools(openaiMessages, tools, toolChoice, modelInfo, tokenAffinity, onServedModel, noFailover, requestedEffort = null, testDeps = null, requestSignal = null, correlation = null) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const meta = { tokenId: null, resumed: false };
  let sdkAttempt = 0;
  const warmAbortCleanups=[];
  const measured = measuredSdkUsage();
  let warmHandle=null;
  const warmObserver=testDeps?.warmCacheObserver||getWarmRuntime();
  const usageJoin = build => { try { if (!correlation) return; const fields = build(); if (testDeps?.onUsageRow) testDeps.onUsageRow({ ...correlation, sdk_attempt: sdkAttempt, ...fields }); else logUsageJoin(correlation, { sdk_attempt: sdkAttempt, ...fields }); } catch {} };
  const run = async () => {
  // Belt-and-braces scrub happens first, before session-key/prefix hashing,
  // progress tracking, or prompt formatting all see the same clean history.
  openaiMessages = scrubSdkNoiseTurns(openaiMessages);
  enforceToolProgress(openaiMessages, modelInfo.modelId);
  const sdkMod = testDeps?.sdkMod || await loadAgentSDK();
  const z = testDeps?.z || await loadZod();
  const model = modelInfo.modelId;
  const effort = resolveClaudeReasoningEffort(requestedEffort);
  logEffectiveEffort(model, 'claude-sdk-tools', effort);

  const tokens = testDeps?.tokens || getAnthropicOAuthTokens();
  if (tokens.length === 0) {
    throw new Error('No Anthropic OAuth tokens found. Log into Claude Code or add tokens to auth-profiles.json.');
  }
  const candidateTokens = tokenAffinity
    ? tokens.filter(t => t.id === tokenAffinity || t.id.includes(tokenAffinity))
    : tokens;
  if (candidateTokens.length === 0) {
    throw new Error(`No token matching affinity "${tokenAffinity}" found.`);
  }
  const now = Date.now();
  const attemptTokens = tokenAffinity
    ? candidateTokens
    : candidateTokens.filter(t => !t.cooldownUntil || t.cooldownUntil < now);

  // Register the caller's tools as in-process MCP tools. Handlers are halt
  // sentinels — we capture the tool_use from the stream, not from execution.
  const SERVER = 'caller-tools';
  const nameMap = new Map(); // mcp__caller-tools__<name> -> original <name>
  const sdkTools = (tools || []).map(t => {
    const fname = t.function?.name || 'tool';
    nameMap.set(`mcp__${SERVER}__${fname}`, fname);
    const shape = jsonSchemaToZodShape(t.function?.parameters, z);
    return sdkMod.tool(
      fname,
      t.function?.description || '',
      shape,
      async () => { throw new Error('__CAPTURE_HALT__'); },
      { alwaysLoad: true }
    );
  });
  const server = sdkMod.createSdkMcpServer({ name: SERVER, version: '1.0.0', tools: sdkTools, alwaysLoad: true });
  const allowedTools = [...nameMap.keys()];

  // Nudge tool usage when the caller demands it (SDK has no direct force-tool).
  const toolChoiceNudge = toolChoice === 'required' || toolChoice === 'any'
    ? '\n\nYou MUST call one of the provided tools to respond.'
    : (typeof toolChoice === 'object' && toolChoice?.function?.name)
      ? `\n\nYou MUST call the tool named "${toolChoice.function.name}" to respond.`
      : '';

  const stripName = (n) => nameMap.get(n) || n.replace(/^mcp__[^_]*(?:__)?[^_]*__/, '') || n;

  const sessionKey = progressSessionKey(openaiMessages, model);

  let lastErr;
  if (attemptTokens.length === 0) {
    lastErr = Object.assign(new Error('All Anthropic tokens in cooldown'), { statusCode: 429 });
  }
  let cacheBudgetRecoveryUsed = false;
  for (let tokenIndex = 0; tokenIndex < attemptTokens.length; tokenIndex++) {
    const token = attemptTokens[tokenIndex];
    (testDeps?.markRequestStart || markRequestStart)(token);
    meta.tokenId = token.id;
    const ac = new AbortController();
    if(correlation?.initiator==='warm_cache_handoff'&&requestSignal){const stop=()=>ac.abort();requestSignal.addEventListener('abort',stop,{once:true});warmAbortCleanups.push(()=>requestSignal.removeEventListener('abort',stop));if(requestSignal.aborted)stop();}
    const queryEnv = { ...process.env };
    if (token.token) queryEnv.CLAUDE_CODE_OAUTH_TOKEN = token.token;
    // Keep the CLI's per-host project memory out of the cached prefix (cause C3).
    queryEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    const isolatedConfigDir = sdkConfigDirForToken(token);
    if (isolatedConfigDir) queryEnv.CLAUDE_CONFIG_DIR = isolatedConfigDir;
    let text = '', usage = {}, servedModel = null, capturedCalls = null, sdkSessionId = null;
    let measuredAttempt;
    let providerResponseObserved = false;
    let failedQueryClosed = false;
    let iter;

    // Resume eligibility: reuse a prior Agent SDK session for this exact
    // sessionKey+model+token if the conversation prefix we're about to send
    // is byte-identical to what that session last saw. This lets Anthropic
    // cache-hit the (often huge, ever-growing) historical prefix instead of
    // reprocessing the entire conversation from scratch every iteration --
    // measured as the real driver of "extremely long turns" on deep
    // sessions (context_length is intentionally 1M / compacts at 500K, so
    // sessions get very deep before Hermes ever trims them). Verified safe
    // against this codebase's exact capture-then-abort-mid-tool-call pattern
    // via isolated testing before this was wired into the live path. Falls
    // back to fresh append-only content blocks on ANY cache miss or prefix
    // mismatch -- never guesses or resumes an aborted tool turn.
    const cached = sdkResumeCache.get(sessionKey);
    let usingResume = false;
    let prompt;
    if (
      cached &&
      cached.model === model &&
      cached.token === token.id &&
      cached.messageCount <= openaiMessages.length &&
      hashMessagesPrefix(openaiMessages, cached.messageCount) === cached.prefixHash
    ) {
      const tail = openaiMessages.slice(cached.messageCount);
      if (tail.length > 0) {
        prompt = formatTailForSDK(tail) + toolChoiceNudge;
        usingResume = true;
      }
    }
    if (!usingResume) {
      // Native subscription sessions already select 1h; match that TTL so
      // the CLI's later attachment marker never follows a shorter 5m marker.
      // Preserve an existing valid override; do not change native cache policy.
      const cacheTtl = queryEnv.CLAUDE_CODE_PROMPT_CACHE_TTL === '5m' ? '5m' : '1h';
      prompt = sdkPromptFromBlocks(formatStableMessagesForSDK(openaiMessages, toolChoiceNudge, cacheTtl));
    }
    meta.resumed = usingResume;

    try {
      log(`SDK tools query (id=${requestId}, model=${model}, token=${token.id})${usingResume ? ' [resumed]' : ''}...`);
      sdkAttempt++;
      measuredAttempt = measured.begin(token, sdkAttempt);
      try{warmHandle=warmObserver?.started({correlation,messages:openaiMessages,tools,model,token,requestId,startedAt:Date.now()});}catch{}
      usageJoin(() => ({ event: "sdk_start", sdk_request: requestId, account_alias: createHash("sha256").update(String(token.id)).digest("hex"), resumed: usingResume, request_started_at_ms:Date.now() }));
      if(correlation?.initiator==='warm_cache_handoff')queryEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS='4096';
      const options = {
        model,
        // SDK isolation mode -- do NOT inherit the operator's personal
        // ~/.claude/settings.json (global MCP servers, skills, custom
        // agents, memory files). This is a shared multi-tenant
        // tool-calling bridge, not a personal coding-assistant session;
        // measured breakdown (getContextUsage()) showed the inherited
        // environment, not the ~245-token system prompt itself, was the
        // real cost driver.
        settingSources: [],
        // Never inherit the host checkout's git status / memory (cause C3).
        cwd: SDK_NEUTRAL_CWD,
        // Provider stream deltas carry terminal output usage before a caller tool abort.
        includePartialMessages: true,
        // Keep the `claude_code` preset (required for billing — a full
        // custom-string replacement broke it, see the reverted
        // ae06377/d89ccbc history) but `append` the operator identity
        // directly onto the real system prompt instead of leaving it
        // unset. Previously OPERATOR_SYSTEM_PROMPT was only prepended
        // into the user-turn `prompt` text (formatMessagesForSDK), which
        // is far weaker than the SDK's actual system-level "you are
        // Claude Code" assertion it was competing against — in practice
        // the model kept self-identifying as Claude Code and reaching
        // for its native tool names (Bash/Read/Write), which is why
        // normalizeToolCalls' alias table exists. `append` keeps this
        // billed as normal claude_code preset usage (verified live via a
        // standalone probe: real usage/cache numbers, no billing error,
        // model correctly self-identified as SubStation and named
        // `write_file` instead of `Write`) while giving the identity
        // real system-level authority.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_SYSTEM_PROMPT },
        permissionMode: 'bypassPermissions',
        // Hermes executes the captured call; a second native SDK turn only
        // starts unneeded inference during the asynchronous abort window.
        maxTurns: 1,
        env: queryEnv,
        mcpServers: { [SERVER]: server },
        allowedTools,
        // Keep the provider's tool schemas identical to the original turn:
        // removing native tools invalidates every downstream cached prefix.
        // PreToolUse denies execution even under bypassPermissions; the MCP
        // handlers only capture calls and the one-turn loop aborts on capture.
        ...(correlation?.initiator==='warm_cache_handoff'?{
          hooks:{PreToolUse:[{hooks:[async()=>({suppressOutput:true,hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Summary-only handoff forbids tool execution'}})]}]},
        }:{}),
        abortController: ac,
        ...(usingResume ? { resume: cached.sdkSessionId } : {}),
      };
      if (effort.effort) options.effort = effort.effort;
      if(correlation?.initiator==='warm_cache_handoff'&&(requestSignal?.aborted||await testDeps?.warmDispatchGuard?.()!==true))throw Error('warm handoff lost live dispatch authority');
      iter = await (testDeps?.sdkMod ? async input => sdkMod.query(input) : input => cappedSdkQuery(sdkMod.query, input, requestSignal))({
        prompt,
        options,
      });

      // This path (the one Hermes actually uses for every tool-calling turn)
      // previously had NO timeout protection at all, unlike its sibling
      // invokeClaudeSDK. A stalled attempt here blocked the whole turn
      // indefinitely with zero visibility -- this was the real cause of
      // "extremely long turns" even after invokeClaudeSDK was fixed.
      const attemptStarted = Date.now();
      let msgCount = 0;
      let hardReject;
      const hardPromise = new Promise((_, reject) => { hardReject = reject; });
      const HARD_TIMEOUT_MS = Number(process.env.SUBSTATION_HARD_TIMEOUT_MS) || 1200000; // 20 min
      const hardTimer = setTimeout(() => hardReject(new Error(`Agent SDK tools hard timeout — attempt exceeded ${HARD_TIMEOUT_MS/1000}s wall-clock`)), HARD_TIMEOUT_MS);
      const heartbeatTimer = setInterval(() => {
        log(`SDK tools query heartbeat (model=${model}, token=${token.id}): ${msgCount} messages, ${Math.round((Date.now()-attemptStarted)/1000)}s elapsed`);
      }, 60000);

      const iteratorLoop = (async () => {
        for await (const msg of iter) {
          msgCount++;
          if (msg.type === 'system' && msg.subtype === 'init') {
            servedModel = msg.model;
            sdkSessionId = msg.session_id || sdkSessionId;
            usageJoin(() => ({ event: 'sdk_identity', sdk_request: requestId, served_model: /^[a-zA-Z0-9._-]{1,100}$/.test(servedModel || '') ? servedModel : null, sdk_session: typeof sdkSessionId === 'string' ? createHash('sha256').update(sdkSessionId).digest('hex') : null }));
            if (servedModel !== model) {
              modelSwapCount++;
              log(`WARN: model swap detected -- requested "${model}" but SDK served "${servedModel}" (token=${token.id})`);
            }
            if (onServedModel) { try { onServedModel(servedModel); } catch {} }
          }
          if (msg.type === 'stream_event') {
            try {
              if ((msg.event?.type === 'message_start' && sdkUsageRow(msg.event.message).provider_model) ||
                  ['content_block_start', 'content_block_delta'].includes(msg.event?.type)) providerResponseObserved = true;
            } catch { providerResponseObserved = true; }
            const finalUsage = measuredAttempt.stream(msg.event);
            if (finalUsage) usageJoin(() => ({ event: 'sdk_provider_message', sdk_request: requestId, ...finalUsage, usage_source: 'provider_stream_terminal', usage_complete: Boolean(finalUsage.provider_model && ['input','output','cache_creation','cache_read'].every(key => finalUsage[key] !== null)) }));
          }
          if (msg.type === 'assistant') {
            try {
              const genuineModel = sdkUsageRow(msg.message).provider_model;
              const syntheticError = msg.isApiErrorMessage || msg.message?.model === '<synthetic>';
              if (genuineModel || (!syntheticError && (msg.message?.content || []).some(b =>
                  b.type === 'tool_use' || (b.type === 'text' && b.text) || (b.type === 'thinking' && b.thinking)))) providerResponseObserved = true;
            } catch { providerResponseObserved = true; }
            measuredAttempt.assistant(msg.message);
            usageJoin(() => ({ event: 'sdk_provider_message', sdk_request: requestId, ...sdkUsageRow(msg.message) }));
            const blocks = msg.message?.content || [];
            for (const b of blocks) if (b.type === 'text' && b.text) text += b.text;
            const toolUse = blocks.filter(b => b.type === 'tool_use');
            if (toolUse.length) {
              capturedCalls = toolUse.map(b => ({
                id: b.id,
                type: 'function',
                function: { name: stripName(b.name), arguments: JSON.stringify(b.input || {}) },
              }));
              try { ac.abort(); } catch {}
              break;
            }
          }
          if (msg.type === 'result') {
            measuredAttempt.result(msg);
            if (msg.usage) usage = msg.usage;
            if (!text && msg.result) text = msg.result;
          }
        }
      })();

      let raceErr = null;
      try {
        await Promise.race([iteratorLoop, hardPromise]);
      } catch (e) {
        raceErr = e;
      } finally {
        clearTimeout(hardTimer);
        clearInterval(heartbeatTimer);
      }
      if (raceErr) {
        // Timed out (or the loop itself threw) -- terminate the underlying
        // process/connection instead of leaking it, mirroring invokeClaudeSDK.
        try { if (typeof iter.close === 'function') { await iter.close(); failedQueryClosed = true; } } catch {}
        throw raceErr;
      }

      (testDeps?.markSuccess || markSuccess)(token);
      resetSubscriptionDenials(token);
      // An SDK query aborted at tool_use is mid-MCP-call. Never resume it
      // with a caller result flattened into the next prompt.
      if (capturedCalls) sdkResumeCache.delete(sessionKey);
      else if (sdkSessionId) {
        sdkResumeCache.set(sessionKey, {
          sdkSessionId, token: token.id, model,
          messageCount: openaiMessages.length,
          prefixHash: hashMessagesPrefix(openaiMessages, openaiMessages.length),
        });
      }
      {
        const _aliasNotes = [];
        const _normalized = normalizeToolCalls(capturedCalls, tools, _aliasNotes) || undefined;
        return { text: scrubNoResponseOutput(appendAliasNote(text, _aliasNotes)), toolCalls: _normalized, usage, servedModel, modelMismatch: servedModel !== null && servedModel !== model };
      }
    } catch (err) {
      // If we already captured the tool call, an abort-triggered throw is success.
      if (capturedCalls) {
        (testDeps?.markSuccess || markSuccess)(token);
      resetSubscriptionDenials(token);
        sdkResumeCache.delete(sessionKey);
        const _aliasNotes = [];
        const _normalized = normalizeToolCalls(capturedCalls, tools, _aliasNotes);
        return { text: scrubNoResponseOutput(appendAliasNote(text, _aliasNotes)), toolCalls: _normalized, usage, servedModel, modelMismatch: servedModel !== null && servedModel !== model };
      }
      if (usingResume) {
        // Resume-specific failure -- the cached session may be stale/gone.
        // Clear it so the next attempt (next token, or Hermes's own retry)
        // falls back cleanly to the full prompt instead of retrying the same
        // broken resume. Never worse than pre-resume behavior.
        sdkResumeCache.delete(sessionKey);
        log(`Token ${token.id} resumed session failed (${err.message}) — cleared resume cache, next attempt uses full context`);
      }
      // A rejected schema request performed no inference or caller action.
      // Retry only this exact resume-cache error, once, on the same account;
      // keep the failed attempt's unknown usage and rebuild unchanged full history.
      const errorText = err.message || '';
      const reportedStatuses = [err.statusCode, err.status].filter(status => status !== undefined && status !== null);
      const exactHttp400 = reportedStatuses.length
        ? reportedStatuses.every(status => status === 400)
        : /^(?:Claude Code returned an error result: )?API Error: 400\b/i.test(errorText);
      const cacheBudgetError = /A maximum of 4 blocks with cache_control may be provided\. Found ([0-9]+)\b/i.exec(errorText);
      if (correlation?.initiator!=='warm_cache_handoff' && usingResume && !cacheBudgetRecoveryUsed && failedQueryClosed && !providerResponseObserved &&
          !requestSignal?.aborted && exactHttp400 && cacheBudgetError && Number(cacheBudgetError[1]) > 4) {
        cacheBudgetRecoveryUsed = true;
        try { ac.abort(); } catch {}
        markRequestEnd(token);
        tokenIndex--;
        log(`Token ${token.id} rejected resumed cache marker budget — retrying once with full context on the same account`);
        continue;
      }
      lastErr = err;
      log(`invokeClaudeSDKWithTools: token ${token.id} failed: ${err.message}`);
      const el = (err.message || '').toLowerCase();
      if (el.includes('timeout')) {
        // Transient stall, not an account cap -- move to the next Anthropic
        // bar with no cooldown (mirrors invokeClaudeSDK's handling).
        log(`Token ${token.id} transient tools-query timeout (not a cap) — trying next Anthropic bar, no cooldown`);
        markRequestEnd(token);
        continue;
      }
      {
        // Confirmed (2x consecutive), last-token-guarded subscription-denial
        // handling. See auth-policy.js handleSubscriptionDenial for why a
        // single occurrence never benches, and why a confirmed denial that
        // would leave zero live Anthropic tokens is spared instead of
        // benched. `tokens` (resolved above) already excludes dead entries,
        // so this counts how many OTHER live Anthropic tokens exist besides
        // this one right now.
        const otherLive = tokens.filter(t => t.id !== token.id && !t.dead).length;
        const denial = handleSubscriptionDenial(err, token, (testDeps?.markDead || markDead), otherLive, log);
        if (denial.isSubscriptionDenial) {
          // Definitive account-level denial (or an unconfirmed 1st occurrence,
          // or a confirmed-but-spared last-token case): stop retrying this
          // account on every tools request. The existing auth revival retries
          // a real bench in 5m. markDead already decremented activeRequests
          // when benched=true; otherwise we still owe that bookkeeping.
          if (!denial.benched) markRequestEnd(token);
          continue;
        }
      }
      if (el.includes('rate') || el.includes('limit') || el.includes('usage') || err.statusCode === 429) {
        const knownSecs = parseKnownResetSeconds(err.message);
        if (knownSecs) {
          log(`Token ${token.id} hit known usage cap — cooling until real reset (~${Math.ceil(knownSecs / 60)}min), skipping repeated doomed retries`);
          markRateLimited(token, knownSecs, true);
        } else {
          markRateLimited(token, 60);
        }
      } else {
        markRequestEnd(token);
      }
    }
  }

  const allFailedErr = new Error(`All Anthropic tokens failed for SDK tool-calling request: ${lastErr ? lastErr.message : 'unknown error'}`);
  if (lastErr && lastErr.statusCode === 429) allFailedErr.statusCode = 429;

  // Cross-provider failover — skip when a specific account was pinned so a
  // deliberate single-account test surfaces the raw truth (no OpenAI disguise).
  if (!tokenAffinity && !noFailover && isCapError(allFailedErr)) {
    const failoverModelId = FAILOVER_MAP[modelInfo.modelId];
    if (failoverModelId) {
      const failoverInfo = resolveModel(failoverModelId);
      log(`>>> FAILOVER: Anthropic SDK tools-path capped → ${failoverModelId} (OpenAI)`);
      try {
        return await invokeCodex(openaiMessages, failoverInfo, null, tools, requestedEffort, requestSignal);
      } catch (codexErr) {
        log(`OpenAI failover also failed: ${codexErr.message}`);
      }
    }
  }
  throw allFailedErr;
  };

  try {
    const result = await run();
    try { result.substationUsage = combineMeasuredUsage(measured.snapshot(), result.substationUsage); } catch {}
    try{warmObserver?.finished(warmHandle,measured.snapshot(),requestSignal?.aborted?'cancelled':'ok',result);}catch{}
    usageJoin(() => ({ event: "sdk_end", sdk_request: requestId, outcome: requestSignal?.aborted ? "client-disconnect" : "ok" }));
    logRequestEnd({
      requestId, path: 'invokeClaudeSDKWithTools', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: meta.resumed ? 'yes' : 'no', startedAt, outcome: requestSignal?.aborted ? 'client-disconnect' : 'ok',
    });
    return result;
  } catch (err) {
    err.substationUsage = measured.snapshot();
    try{warmObserver?.finished(warmHandle,err.substationUsage,'error');}catch{}
    const outcome = requestSignal?.aborted ? 'client-disconnect' : classifyInvokeError('invokeClaudeSDKWithTools', err);
    usageJoin(() => ({ event: "sdk_end", sdk_request: requestId, outcome }));
    logRequestEnd({
      requestId, path: 'invokeClaudeSDKWithTools', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: meta.resumed ? 'yes' : 'no', startedAt, outcome,
    });
    throw err;
  }finally{for(const remove of warmAbortCleanups)remove();}
}

// LEGACY raw-REST tool-calling path. Kept as a fallback but no longer the
// primary — Anthropic's edge 429s these OAuth requests persistently. The
// /v1/chat/completions handler now calls invokeClaudeSDKWithTools first.
async function invokeClaudeMessagesAPIWithTools(openaiMessages, tools, toolChoice, modelInfo, tokenAffinity, requestSignal = null, testDeps = null) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const meta = { tokenId: null };
  const run = async () => {
  const tokens = testDeps?.tokens || getAnthropicOAuthTokens();
  if (tokens.length === 0) {
    throw new Error('No Anthropic OAuth tokens found. Log into Claude Code or add tokens to auth-profiles.json.');
  }

  const candidateTokens = tokenAffinity
    ? tokens.filter(t => t.id === tokenAffinity || t.id.includes(tokenAffinity))
    : tokens;
  if (candidateTokens.length === 0) {
    throw new Error(`No token matching affinity "${tokenAffinity}" found.`);
  }

  // Skip tokens already known to be in cooldown — UNLESS the caller pinned a
  // specific account, in which case always hit the live API for a fresh
  // ground-truth answer rather than short-circuiting on stale local state.
  const now = Date.now();
  const attemptTokens = tokenAffinity
    ? candidateTokens
    : candidateTokens.filter(t => !t.cooldownUntil || t.cooldownUntil < now);

  const { system, messages } = convertOpenAIMessagesToAnthropic(openaiMessages);
  const anthropicTools = convertOpenAIToolsToAnthropic(tools);
  const anthropicToolChoice = anthropicTools ? convertOpenAIToolChoiceToAnthropic(toolChoice) : undefined;

  const body = {
    model: modelInfo.modelId,
    max_tokens: modelInfo.maxTokens || 8192,
    messages,
    stream: false,
  };
  if (system) body.system = system;
  if (anthropicTools) body.tools = anthropicTools;
  if (anthropicToolChoice) body.tool_choice = anthropicToolChoice;

  const bodyStr = JSON.stringify(body);

  log(`Messages API tools request (id=${requestId}, model=${modelInfo.modelId}, body=${bodyStr.length}b)`);

  let lastErr;
  if (attemptTokens.length === 0) {
    lastErr = Object.assign(new Error('All Anthropic tokens in cooldown'), { statusCode: 429 });
  }
  for (const token of attemptTokens) {
    markRequestStart(token);
    meta.tokenId = token.id;
    try {
      const result = await (testDeps?.makeAnthropicRequest || makeAnthropicRequest)(bodyStr, token);
      markSuccess(token);
      resetSubscriptionDenials(token);
      const { text, toolCalls } = anthropicContentToOpenAIToolCalls(result.content);
      const _aliasNotes = [];
      const _normalized = normalizeToolCalls(toolCalls, tools, _aliasNotes);
      return { text: appendAliasNote(text, _aliasNotes), toolCalls: _normalized, usage: result.usage };
    } catch (err) {
      if (err.code === 'SUBSTATION_UNSUPPORTED_TOOL') throw err;
      lastErr = err;
      log(`invokeClaudeMessagesAPIWithTools: token ${token.id} failed: ${err.message}`);
      // Confirmed (2x consecutive), last-token-guarded subscription-denial
      // handling — this path previously had NO auth-denial handling at all
      // (any error not statusCode 429 fell straight to the generic
      // markRequestEnd branch below), so an org-disabled account stayed in
      // rotation here indefinitely. See WO-flex-substation-fix4.
      const otherLive = tokens.filter(t => t.id !== token.id && !t.dead).length;
      const denial = handleSubscriptionDenial(err, token, (testDeps?.markDead || markDead), otherLive, log);
      if (denial.isSubscriptionDenial) {
        if (!denial.benched) markRequestEnd(token);
        continue;
      }
      if (err.statusCode === 429) {
        markRateLimited(token, parseInt(err.retryAfter || '60', 10));
      } else {
        markRequestEnd(token);
      }
    }
  }
  const allFailedErr = new Error(`All Anthropic tokens failed for tool-calling request: ${lastErr ? lastErr.message : 'unknown error'}`);
  if (lastErr && lastErr.statusCode === 429) allFailedErr.statusCode = 429;

  // Cross-provider failover — this path previously had NO failover at all
  // (unlike invokeClaudeSDK/invokeModel below), so a single rate-limited
  // Anthropic token stalled every tool-calling turn even with healthy
  // OpenAI/Codex tokens sitting idle. Mirror invokeModel's cap-error pattern.
  // BUT: skip this when the caller pinned a specific account (tokenAffinity)
  // — that's used to deliberately test/force one account with no disguise;
  // silently rolling over to OpenAI there would hide whether that account
  // actually works.
  if (!tokenAffinity && isCapError(allFailedErr)) {
    const failoverModelId = FAILOVER_MAP[modelInfo.modelId];
    if (failoverModelId) {
      const failoverInfo = resolveModel(failoverModelId);
      log(`>>> FAILOVER: Anthropic tools-path capped → ${failoverModelId} (OpenAI)`);
      try {
        return await invokeCodex(openaiMessages, failoverInfo, null, tools, null, requestSignal);
      } catch (codexErr) {
        log(`OpenAI failover also failed: ${codexErr.message}`);
      }
    }
  }

  throw allFailedErr;
  };

  try {
    const result = await run();
    logRequestEnd({
      requestId, path: 'invokeClaudeMessagesAPIWithTools', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome: requestSignal?.aborted ? 'client-disconnect' : 'ok',
    });
    return result;
  } catch (err) {
    const outcome = requestSignal?.aborted ? 'client-disconnect' : classifyInvokeError('invokeClaudeMessagesAPIWithTools', err);
    logRequestEnd({
      requestId, path: 'invokeClaudeMessagesAPIWithTools', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome,
    });
    throw err;
  }
}

async function invokeClaudeSDK(openaiMessages, modelInfo, onDelta, tokenAffinity, onServedModel, requestedEffort = null, requestSignal = null, testDeps = null, correlation = null) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const meta = { tokenId: null };
  const measured = measuredSdkUsage();
  let warmHandle=null;
  const warmObserver=testDeps?.warmCacheObserver||getWarmRuntime();
  const usageJoin = fields => { try { if (testDeps?.onUsageRow) testDeps.onUsageRow({ ...correlation, ...fields }); else logUsageJoin(correlation, fields); } catch {} };
  const run = async () => {
  enforceToolProgress(openaiMessages, modelInfo.modelId);
  const model = modelInfo.modelId;
  const effort = resolveClaudeReasoningEffort(requestedEffort);
  logEffectiveEffort(model, 'claude-sdk', effort);
  const tokens = testDeps?.tokens || getAnthropicOAuthTokens();
  if (tokens.length === 0) {
    throw new Error('No Anthropic OAuth tokens found. Log into Claude Code or add tokens to auth-profiles.json.');
  }

  // If token affinity specified, filter to that token
  const candidateTokens = tokenAffinity
    ? tokens.filter(t => t.id === tokenAffinity || t.id.includes(tokenAffinity))
    : tokens;
  if (candidateTokens.length === 0) {
    throw new Error(`No token matching affinity "${tokenAffinity}" found.`);
  }

  // All tokens in cooldown. OpenAI is a LAST resort — so distinguish a short
  // transient backoff (60–120s blip) from a genuine multi-hour usage cap.
  //   • short cooldown  → WAIT it out and retry Anthropic (stay on Claude/tools)
  //   • long cap        → throw 429 so invokeModel can divert to OpenAI
  // This stops a momentary rate-blip on both bars from kicking the whole session
  // onto the GPT lane (where tool calls degrade and the agent narrates instead).
  const now = Date.now();
  let available = candidateTokens.filter(t => !t.cooldownUntil || t.cooldownUntil < now);
  if (available.length === 0) {
    const earliest = candidateTokens.reduce((min, t) => t.cooldownUntil && (!min || t.cooldownUntil < min) ? t.cooldownUntil : min, null);
    const secsLeft = earliest ? Math.ceil((earliest - now) / 1000) : 60;
    const SHORT_COOLDOWN_WAIT_S = 120; // catches the 60s/120s exponential-backoff levels (transient blips)
    if (secsLeft <= SHORT_COOLDOWN_WAIT_S) {
      log(`All Anthropic bars cooling but soonest frees in ${secsLeft}s — waiting on Anthropic instead of diverting to OpenAI`);
      await new Promise(r => setTimeout(r, (secsLeft + 1) * 1000));
      const now2 = Date.now();
      available = candidateTokens.filter(t => !t.cooldownUntil || t.cooldownUntil < now2);
    }
    if (available.length === 0) {
      const minsLeft = Math.ceil(secsLeft / 60);
      log(`All Anthropic tokens genuinely capped (~${minsLeft}min) — allowing OpenAI last-resort failover`);
      throw Object.assign(new Error(`All Anthropic tokens in cooldown — rate limit resets in ~${minsLeft}min`), { statusCode: 429, retryAfterSec: secsLeft });
    }
  }

  // Format full conversation context including system prompts and history
  const prompt = formatMessagesForSDK(openaiMessages);

  // Build a deterministic rotation over ALL available bars — each tried exactly
  // once, no repeats — so EVERY Anthropic bar is exhausted before the caller
  // (invokeModel) is allowed to fail over to OpenAI as a last resort.
  // OLD BUG: loop used `selectAnthropicToken()` on attempt 0 then `tokens[attempt % len]`
  // afterwards, which could pick the same bar twice and skip the other entirely —
  // failing straight to OpenAI with a healthy bar untouched.
  let rotation;
  if (tokenAffinity) {
    rotation = available;
  } else {
    const sorted = [...available].sort((a, b) => {
      const aProven = a.lastSuccess > 0 ? 0 : 1;
      const bProven = b.lastSuccess > 0 ? 0 : 1;
      if (aProven !== bProven) return aProven - bProven; // proven bars first
      return a.errorCount - b.errorCount;                // then fewest errors
    });
    // Round-robin only the STARTING point (load-balance), then walk every bar once.
    const start = anthropicRRIndex % sorted.length;
    anthropicRRIndex = (anthropicRRIndex + 1) % sorted.length;
    rotation = sorted.slice(start).concat(sorted.slice(0, start));
  }

  const maxAttempts = rotation.length;
  let lastError = null;
  log(`Anthropic rotation order: [${rotation.map(t => t.id).join(' → ')}] then OpenAI last-resort`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = rotation[attempt];
    if (!token) break;

    const key = `${model}:${token.id}`;
    log(`Agent SDK request (id=${requestId}, model=${model}, token=${token.id}, attempt=${attempt + 1}/${maxAttempts})`);
    markRequestStart(token);
    meta.tokenId = token.id;
    const measuredAttempt = measured.begin(token, attempt + 1);
    try{warmHandle=warmObserver?.started({correlation,messages:openaiMessages,tools:[],model,token,requestId,startedAt:Date.now()});}catch{}
    usageJoin({event:"sdk_start",sdk_request:requestId,sdk_attempt:attempt+1,account_alias:createHash("sha256").update(String(token.id)).digest("hex"),resumed:false,request_started_at_ms:Date.now()});

    try {
      const iter = await (testDeps?.querySDK || querySDK)(model, token.id, token.token, prompt, effort, requestId, requestSignal);
      const attemptStarted = Date.now();

      let text = '';
      let usage = {};
      let hadToolUse = false;
      let servedModel = null;
      let idleReject;
      const idlePromise = new Promise((_, reject) => { idleReject = reject; });
      const IDLE_TIMEOUT = Number(process.env.SUBSTATION_IDLE_TIMEOUT_MS) || 300000;
      const TOOL_IDLE_TIMEOUT = 900000;
      let idleTimer;
      let toolRunning = false;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const timeout = toolRunning ? TOOL_IDLE_TIMEOUT : IDLE_TIMEOUT;
        idleTimer = setTimeout(() => idleReject(new Error(`Agent SDK timeout — no stream activity for ${timeout/1000}s`)), timeout);
      };
      resetIdleTimer();

      // Hard wall-clock ceiling, independent of message activity. The idle
      // timer above only fires if activity stops; if messages keep trickling
      // in (or the underlying stream/process dies without ever surfacing a
      // terminal message), a single attempt can otherwise run unbounded since
      // maxTurns is Infinity. This is defense-in-depth, not a replacement.
      let hardReject;
      const hardPromise = new Promise((_, reject) => { hardReject = reject; });
      const HARD_TIMEOUT_MS = Number(process.env.SUBSTATION_HARD_TIMEOUT_MS) || 1200000; // 20 min
      const hardTimer = setTimeout(() => hardReject(new Error(`Agent SDK hard timeout — attempt exceeded ${HARD_TIMEOUT_MS/1000}s wall-clock`)), HARD_TIMEOUT_MS);

      // Heartbeat so a stalled attempt is visible in the log instead of silent
      // for 30+ minutes (this was previously undiagnosable without attaching
      // a debugger — the loop below had zero per-message logging).
      let msgCount = 0;
      const heartbeatTimer = setInterval(() => {
        log(`SDK query heartbeat (model=${model}, token=${token.id}): ${msgCount} messages, ${Math.round((Date.now()-attemptStarted)/1000)}s elapsed, toolRunning=${toolRunning}`);
      }, 60000);

      const iteratorLoop = (async () => {
        for await (const msg of iter) {
          msgCount++;
          resetIdleTimer();
          if (msg.type === 'system' && msg.subtype === 'init') {
            // Swap-detection guard: the Agent SDK's own init message reports
            // the model it actually initialized with -- compare against what
            // we asked for. Non-fatal: log + counter + surface via callback
            // (the HTTP handler turns this into an x-substation-served-model
            // response header), never throws/blocks the request.
            servedModel = msg.model;
            if (servedModel !== model) {
              modelSwapCount++;
              log(`WARN: model swap detected -- requested "${model}" but Agent SDK served "${servedModel}" (token=${token.id}, swapCount=${modelSwapCount})`);
            }
            if (onServedModel) { try { onServedModel(servedModel); } catch {} }
          }
          if (msg.type === 'user') {
            toolRunning = false;
            resetIdleTimer();
          }
          if (msg.type === 'assistant') {
            measuredAttempt.assistant(msg.message);
            try { usageJoin({event:'sdk_provider_message',sdk_request:requestId,sdk_attempt:attempt+1,...sdkUsageRow(msg.message)}); } catch {}
            for (const block of (msg.message?.content || [])) {
              if (block.type === 'tool_use') {
                hadToolUse = true;
                toolRunning = true;
                resetIdleTimer();
                log(`SDK tool_use (model=${model}, token=${token.id}): ${block.name}`);
              }
              if (block.type === 'text' && block.text) {
                text += block.text;
                if (onDelta) onDelta(block.text);
              }
            }
          } else if (msg.type === 'rate_limit_event') {
            const info = msg.rate_limit_info || {};
            if (info.status && !info.status.startsWith('allowed')) {
              const cooldownMs = info.resetsAt ? Math.max(0, info.resetsAt * 1000 - Date.now()) : DEAD_REVIVE_MS;
              const resetStr = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : 'unknown';
              throw Object.assign(new Error(`usage limit hit — resets at ${resetStr} (${info.rateLimitType || 'claude_max'}) — cooldown ${Math.ceil(cooldownMs/60000)}min`), { statusCode: 429 });
            }
          } else if (msg.type === 'result') {
            measuredAttempt.result(msg);
            if (msg.usage) usage = msg.usage;
            if (msg.is_error && msg.result) throw new Error(msg.result);
            if (msg.result && !text) text = msg.result;
          }
        }
      })();

      let raceErr = null;
      try {
        await Promise.race([iteratorLoop, idlePromise, hardPromise]);
      } catch (e) {
        raceErr = e;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        clearInterval(heartbeatTimer);
      }
      if (raceErr) {
        // Any exit here (idle timeout, hard timeout, or an error surfaced by
        // the loop itself) means we're abandoning this query -- terminate the
        // underlying process/connection instead of leaking it.
        try { if (typeof iter.close === 'function') iter.close(); } catch {}
        throw raceErr;
      }

      if (!text) throw new Error('Empty response from Claude via Agent SDK');

      if (trackNarration(model, hadToolUse, text)) {
        throw new Error('BLOCKED: Agent produced consecutive narration-only responses with no tool calls. Re-send with a specific instruction.');
      }

      markSuccess(token);
      resetSubscriptionDenials(token);
      return { text, usage, servedModel, modelMismatch: servedModel !== null && servedModel !== model };
    } catch (err) {
      lastError = err;
      log(`Agent SDK error (token=${token.id}): ${err.message}`);

      // Narration loop block is TERMINAL — do not retry with another token
      if (err.message && err.message.startsWith('BLOCKED:')) {
        throw err;
      }

      // A transient SDK idle-timeout is NOT an account cap. Do NOT cool the bar —
      // that would falsely mark a healthy bar "rate limited" and, if both bars blip
      // at once, kick the whole session onto the OpenAI lane. Just move to the next
      // Anthropic bar with no cooldown; if all bars blip, we surface the error and
      // STAY on Anthropic rather than degrade to GPT.
      const errLower = (err.message || '').toLowerCase();
      if (errLower.includes('timeout')) {
        log(`Token ${token.id} transient timeout (not a cap) — trying next Anthropic bar, no cooldown`);
        markRequestEnd(token);
        continue;
      }

      // If genuinely rate/usage limited, cooldown for the actual window duration (not just 30 min)
      if (errLower.includes('rate') || errLower.includes('limit') || errLower.includes('usage') || errLower.includes('hit your') || errLower.includes('resets')) {
        const knownSecs = parseKnownResetSeconds(err.message);
        const cooldownSec = knownSecs || (DEAD_REVIVE_MS / 1000);
        log(`Token ${token.id} hit usage/rate limit — cooldown ${Math.ceil(cooldownSec / 60)}min (until ${new Date(Date.now() + cooldownSec * 1000).toISOString()}), failing over...`);
        markRateLimited(token, cooldownSec, true);
        continue;
      }

      // Confirmed (2x consecutive), last-token-guarded subscription-denial
      // handling — MUST run before the generic isAuthError bench below,
      // which would otherwise catch this exact message (isAuthError's OR
      // list includes isDisabledSubscriptionError) and bench on a single
      // occurrence with no last-token check. See WO-flex-substation-fix4.
      {
        const otherLive = tokens.filter(t => t.id !== token.id && !t.dead).length;
        const denial = handleSubscriptionDenial(err, token, (testDeps?.markDead || markDead), otherLive, log);
        if (denial.isSubscriptionDenial) {
          if (!denial.benched) markRequestEnd(token);
          continue;
        }
      }

      // Auth error — bench this token for 24h and try next
      if (isAuthError(err)) {
        markDead(token, 'auth'); // marks dead + decrements activeRequests
        continue;
      }

      // Other errors — decrement activeRequests and try next token
      markRequestEnd(token);
      continue;
    }
  }

  throw lastError || new Error('All Anthropic tokens exhausted. Check your Claude Max subscription status.');
  };

  try {
    const result = await run();
    try { result.substationUsage = combineMeasuredUsage(measured.snapshot(), result.substationUsage); } catch {}
    try{warmObserver?.finished(warmHandle,measured.snapshot(),requestSignal?.aborted?'cancelled':'ok',result);}catch{}
    usageJoin({event:"sdk_end",sdk_request:requestId,outcome:requestSignal?.aborted?"client-disconnect":"ok"});
    logRequestEnd({
      requestId, path: 'invokeClaudeSDK', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome: requestSignal?.aborted ? 'client-disconnect' : 'ok',
    });
    return result;
  } catch (err) {
    err.substationUsage = measured.snapshot();
    try{warmObserver?.finished(warmHandle,err.substationUsage,'error');}catch{}
    usageJoin({event:'sdk_end',sdk_request:requestId,outcome:'error'});
    const outcome = requestSignal?.aborted ? 'client-disconnect' : classifyInvokeError('invokeClaudeSDK', err);
    logRequestEnd({
      requestId, path: 'invokeClaudeSDK', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Codex API caller with pool rotation
// ---------------------------------------------------------------------------

async function invokeCodex(openaiMessages, modelInfo, onDelta, tools, requestedEffort = null, requestSignal = null, onServedModel = null, requestOpts = {}) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const meta = { tokenId: null };
  const retryBudget = requestOpts.retryBudget === 0 ? 0 : 1;
  let upstreamAttempts = 0;
  const attemptRequest = async (bodyStr, tokenEntry, wrappedDelta) => {
    if (requestSignal?.aborted) throw Object.assign(new Error('Codex request canceled by client'), { code: 'ABORT_ERR', statusCode: 0 });
    if (upstreamAttempts >= retryBudget + 1) throw Object.assign(new Error('Codex retry budget exhausted'), { statusCode: 0 });
    upstreamAttempts++;
    return makeCodexRequest(bodyStr, tokenEntry, wrappedDelta, onServedModel, requestSignal,
      { wrapper: requestId, attempt: upstreamAttempts, proxy: requestOpts.proxyId || null, correlation: requestOpts.correlation || null });
  };
  const run = async () => {
  enforceToolProgress(openaiMessages, modelInfo.modelId);
  const provider = 'openai';
  const providerTokens = pool.filter(t => t.provider === provider);
  if (providerTokens.length === 0) {
    throw new Error('No ChatGPT tokens configured. Run "substation-auth chatgpt" to set up authentication.');
  }

  const effort = resolveCodexReasoningEffort(requestedEffort, modelInfo);
  logEffectiveEffort(modelInfo.modelId, 'codex', effort);
  const bodyStr = JSON.stringify(buildCodexBody(openaiMessages, modelInfo, tools, requestedEffort));
  const requestHash = codexRequestHash(bodyStr);
  const cachedFailure = getCachedCodexFailure(requestHash);
  if (cachedFailure) {
    throw Object.assign(
      new Error(`Repeated Codex request blocked for ${Math.ceil((cachedFailure.until - Date.now()) / 1000)}s after ${cachedFailure.failures} recent upstream stall(s): ${cachedFailure.message}`),
      { statusCode: 0 }
    );
  }
  log(`Codex request (id=${requestId}, model=${modelInfo.modelId}, body=${bodyStr.length}b, hash=${requestHash})`);

  const maxAttempts = Math.max(1, Math.min(providerTokens.length, CODEX_MAX_TOKEN_ATTEMPTS, retryBudget + 1));
  let lastError = null;
  let streamStarted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tokenEntry = selectToken(provider);
    if (!tokenEntry) break;

    markRequestStart(tokenEntry);
    meta.tokenId = tokenEntry.id;
    log(`Attempt ${attempt + 1}/${maxAttempts} using token ${tokenEntry.id}`);

    const wrappedDelta = onDelta ? (delta) => { streamStarted = true; onDelta(delta); } : null;

    try {
      const result = await attemptRequest(bodyStr, tokenEntry, wrappedDelta);
      codexRequestFailureCache.delete(requestHash);
      markSuccess(tokenEntry);
      return { ...result, toolCalls: normalizeToolCalls(result.toolCalls, tools) };
    } catch (err) {
      lastError = err;
      if (err.code === 'SUBSTATION_UNSUPPORTED_TOOL') { markRequestEnd(tokenEntry); throw err; }
      if (requestSignal?.aborted || err.code === 'ABORT_ERR' || err.codexOutputObserved || streamStarted) { markRequestEnd(tokenEntry); throw err; }
      if (upstreamAttempts >= retryBudget + 1) { rememberCodexFailure(requestHash, err); markRequestEnd(tokenEntry); throw err; }
      if (err.statusCode === 429) { markRateLimited(tokenEntry, parseInt(err.retryAfter || '60', 10)); continue; }
      if (isCodexSessionStallError(err)) {
        if (tokenEntry.refreshToken) {
          try {
            log(`Token ${tokenEntry.id} got Codex session stall (${err.message}), refreshing and retrying once without benching token...`);
            await refreshOpenAIToken(tokenEntry);
            const result = await attemptRequest(bodyStr, tokenEntry, wrappedDelta);
            codexRequestFailureCache.delete(requestHash);
            markSuccess(tokenEntry);
            return { ...result, toolCalls: normalizeToolCalls(result.toolCalls, tools) };
          } catch (refreshErr) {
            if (requestSignal?.aborted || refreshErr.code === 'ABORT_ERR' || refreshErr.codexOutputObserved || streamStarted || refreshErr.code === 'SUBSTATION_UNSUPPORTED_TOOL') { markRequestEnd(tokenEntry); throw refreshErr; }
            log(`Token ${tokenEntry.id} Codex session stall persisted after refresh; keeping token alive: ${refreshErr.message}`);
            markRequestEnd(tokenEntry);
            throw refreshErr;
          }
        }
        markRequestEnd(tokenEntry);
        throw err;
      }
      if (err.statusCode === 401) {
        if (tokenEntry.refreshToken) {
          try {
            log(`Token ${tokenEntry.id} got Codex auth failure, attempting refresh...`);
            await refreshOpenAIToken(tokenEntry);
            const result = await attemptRequest(bodyStr, tokenEntry, wrappedDelta);
            codexRequestFailureCache.delete(requestHash);
            markSuccess(tokenEntry);
            return { ...result, toolCalls: normalizeToolCalls(result.toolCalls, tools) };
          } catch (refreshErr) {
            if (requestSignal?.aborted || refreshErr.code === 'ABORT_ERR' || refreshErr.codexOutputObserved || streamStarted || refreshErr.code === 'SUBSTATION_UNSUPPORTED_TOOL') { markRequestEnd(tokenEntry); throw refreshErr; }
            log(`Token ${tokenEntry.id} refresh did not clear Codex auth failure: ${refreshErr.message}`);
            markDead(tokenEntry, 'auth');
            if (upstreamAttempts >= retryBudget + 1) throw refreshErr;
            continue;
          }
        }
        markDead(tokenEntry, 'auth');
        continue;
      }
      if (isCodexTransientError(err) && attempt < maxAttempts - 1) {
        markRateLimited(tokenEntry, 30);
        log(`Token ${tokenEntry.id} transient Codex failure — rotating to next token: ${err.message}`);
        continue;
      }
      rememberCodexFailure(requestHash, err);
      markRequestEnd(tokenEntry);
      throw err;
    }
  }

  rememberCodexFailure(requestHash, lastError);
  throw lastError || new Error('All ChatGPT tokens exhausted. Run "substation-auth chatgpt" to re-authenticate.');
  };

  try {
    const result = await run();
    try {
      result.substationUsage = measuredOpenAIUsage(result.usage, result.servedModel, meta.tokenId, upstreamAttempts);
      logUsageJoin(requestOpts.correlation, {event:"proxy_measured_usage",sdk_request:requestId,...result.substationUsage});
    } catch {}
    logRequestEnd({
      requestId, path: 'invokeCodex', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome: requestSignal?.aborted ? 'client-disconnect' : 'ok',
    });
    return result;
  } catch (err) {
    err.codexAttempts = upstreamAttempts;
    err.codexRetryBudgetRemaining = Math.max(0, retryBudget + 1 - upstreamAttempts);
    const outcome = requestSignal?.aborted ? 'client-disconnect' : classifyInvokeError('invokeCodex', err);
    logRequestEnd({
      requestId, path: 'invokeCodex', model: modelInfo.modelId, tokenId: meta.tokenId,
      resumed: 'n/a', startedAt, outcome,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-provider failover — when one provider's cap hits, route to the other
// ---------------------------------------------------------------------------

const FAILOVER_MAP = {
  // Anthropic → OpenAI equivalents. Use GPT-5.6 Sol as the flagship OpenAI
  // failover target when Anthropic caps out.
  'claude-opus-5-5':           'gpt-5.6-sol',
  'claude-fable-5':            'gpt-5.6-sol',
  'claude-opus-4-8':           'gpt-5.6-sol',
  'claude-opus-4-7':           'gpt-5.6-sol',
  'claude-opus-4-6':           'gpt-5.6-sol',
  'claude-sonnet-4-6':         'gpt-5.6-sol',
  'claude-haiku-4-5-20251001': 'gpt-5.4-mini',
  // OpenAI → Anthropic equivalents
  'gpt-6-astra':         'claude-opus-5-5',
  'gpt-6-sol':           'claude-opus-5-5',
  'gpt-6-luna':          'claude-sonnet-5',
  'gpt-5.5':             'claude-opus-5-5',
  'gpt-5.6-terra':       'claude-opus-5-5',
  'gpt-5.6-sol':         'claude-opus-5-5',
  'gpt-5.6':             'claude-opus-5-5',
  'gpt-5.4':             'claude-opus-5-5',
  'gpt-5.3-codex':       'claude-opus-5-5',
  'gpt-5.1-codex-max':   'claude-opus-5-5',
  'gpt-5.1-codex':       'claude-sonnet-5',
  'gpt-5.4-mini':        'claude-haiku-4-5-20251001',
  'gpt-5.1-codex-mini':  'claude-haiku-4-5-20251001',
};

function isCapError(err) {
  const msg = (err.message || '').toLowerCase();
  // NOTE: must be a GENUINE cap. A bare 'rate' substring matched too much
  // (timeouts, transient blips) and falsely diverted healthy sessions to OpenAI.
  // A pure SDK timeout is explicitly NOT a cap.
  if (msg.includes('timeout')) return false;
  return msg.includes('hit your limit') ||
    msg.includes('usage limit') ||
    msg.includes('rate limit') ||
    msg.includes('exhausted') ||
    msg.includes('all anthropic tokens') ||
    msg.includes('all chatgpt tokens') ||
    err.statusCode === 429;
}

// ---------------------------------------------------------------------------
// Unified dispatcher — Anthropic token rotation → Direct API → Codex failover
// ---------------------------------------------------------------------------

async function invokeModel(openaiMessages, model, onDelta, opts = {}) {
  // Parse per-account suffix: "opus-4-6:acct2-yourname" → model=opus-4-6, tokenAffinity=acct2-yourname
  let baseModel = model;
  if (!opts.tokenAffinity && model.includes(':')) {
    const colonIdx = model.indexOf(':');
    baseModel = model.slice(0, colonIdx);
    opts = { ...opts, tokenAffinity: model.slice(colonIdx + 1) };
  }
  const modelInfo = resolveModel(baseModel);

  if (modelInfo.provider === 'anthropic') {
    // --- Agent SDK (Claude OAuth) — only path for Anthropic models ---
    try {
      return await invokeClaudeSDK(openaiMessages, modelInfo, onDelta, opts.tokenAffinity || null, opts.onServedModel, opts.reasoningEffort || null, opts.requestSignal || null, null, opts.correlation || null);
    } catch (err) {
      const isSdkBroken = err.message && (err.message.includes('is not a function') || err.message.includes('not installed'));
      if (!isCapError(err) && !isSdkBroken) throw err;
      log(isSdkBroken ? `SDK unavailable: ${err.message}` : `SDK path capped: ${err.message}`);

      // Cross-provider failover to OpenAI — but NOT when a specific account was
      // pinned (tokenAffinity). A deliberate account pin must never be silently
      // disguised by an OpenAI answer; surface the raw Anthropic error instead.
      // (Matches the guard already on both tool-calling paths, lines ~1913/2000.)
      const failoverModelId = FAILOVER_MAP[modelInfo.modelId];
      if (!opts.tokenAffinity && !opts.noFailover && failoverModelId) {
        const failoverInfo = resolveModel(failoverModelId);
        log(`>>> FAILOVER: Anthropic capped → ${failoverModelId} (OpenAI)`);
        try {
          const fallback = await invokeCodex(openaiMessages, failoverInfo, onDelta, undefined, opts.reasoningEffort || null, opts.requestSignal || null, opts.onServedModel || null, opts);
          try { fallback.substationUsage = combineMeasuredUsage(err.substationUsage, fallback.substationUsage); } catch {}
          return fallback;
        } catch (codexErr) {
          log(`OpenAI failover also failed: ${codexErr.message}`);
        }
      }

      throw err;
    }
  }

  // --- OpenAI primary path with reverse failover to Anthropic ---
  try {
    return await invokeCodex(openaiMessages, modelInfo, onDelta, undefined, opts.reasoningEffort || null, opts.requestSignal || null, opts.onServedModel || null, opts);
  } catch (err) {
    if (err.codexOutputObserved || err.code === 'ABORT_ERR' || opts.requestSignal?.aborted || !isCapError(err)) throw err;

    const failoverModelId = FAILOVER_MAP[modelInfo.modelId];
    if (opts.noFailover || !failoverModelId) throw err;

    const failoverInfo = resolveModel(failoverModelId);
    log(`>>> FAILOVER: Codex capped → ${failoverModelId} (Anthropic)`);
    try {
      return await invokeClaudeSDK(openaiMessages, failoverInfo, onDelta, null, opts.onServedModel, opts.reasoningEffort || null, opts.requestSignal || null, null, opts.correlation || null);
    } catch (anthropicErr) {
      log(`Anthropic failover also failed: ${anthropicErr.message}`);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Port conflict resolution
// ---------------------------------------------------------------------------

function killStaleProcess(port) {
  try {
    const pid = execSync(`/usr/sbin/lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
    if (pid && pid !== String(process.pid)) {
      log(`Killing stale process ${pid} on port ${port}`);
      execSync(`kill ${pid}`, { timeout: 5000 });
      for (let i = 0; i < 10; i++) {
        try {
          execSync(`/usr/sbin/lsof -ti :${port}`, { timeout: 2000 });
          execSync('sleep 0.3');
        } catch {
          return true;
        }
      }
    }
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('No such file')) {
      log('lsof not available — cannot resolve port conflict');
      return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

let proxyServer = null;

const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
}, 60000).unref();

function safeEnd(res, statusCode, body) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Inbound request bodies: decode with a streaming UTF-8 decoder.  `body += chunk`
// on raw Buffers decodes every chunk on its own, so a multi-byte character that
// straddles a chunk boundary (Node delivers 64 KiB chunks) becomes U+FFFD U+FFFD.
// Hermes sends its system prompt first, so a split "§" at byte 65,536 rewrote the
// whole cached prefix on ~12% of requests (cache-cliff WO 2026-10-06, cause C4: 84 of
// 255 cliffs, 16.8M cache-write tokens in 1.3 days).
// setEncoding installs a StringDecoder that holds incomplete sequences across chunks.
function readUtf8Body(req, maxBytes, onTooLarge) {
  req.setEncoding('utf8');
  const state = { text: '', bytes: 0, tooLarge: false };
  req.on('data', c => {
    state.bytes += Buffer.byteLength(c, 'utf8');
    if (state.bytes > maxBytes) {
      if (!state.tooLarge) { state.tooLarge = true; onTooLarge(); }
      return;
    }
    state.text += c;
  });
  return state;
}

function startProxy() {
  if (proxyServer) return;
  // OFF unless an explicit owned configuration and qualified main-turn evidence exist.
  if(typeof getWarmRuntime==='function'&&typeof setInterval==='function'){
    const check=()=>getWarmRuntime().tick().catch(()=>{});
    const warmTimer=setInterval(check,15000);warmTimer.unref();
    // Atomic publisher/config changes cancel in-flight summaries immediately
    // when observed, without sending a pane key or touching gateway transport.
    for(const [directory,name]of [[DATA_DIR,'warm-cache-handoff-config.json'],[join(homedir(),'.hermes','state'),'warm-cache-lifecycle.json']]){
      try{watch(directory,{persistent:false},(_event,file)=>{if(String(file)===name)check();});}catch{}
    }
  }

  proxyServer = createServer(async (req, res) => {
    // CORS: only allow localhost/127.0.0.1 origins
    const origin = req.headers['origin'];
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const clientIp = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateLimitMap.get(clientIp);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      rateLimitMap.set(clientIp, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT_MAX) {
      safeEnd(res, 429, { error: 'rate_limited', message: 'Too many requests. Limit: 120/minute.' });
      return;
    }

    // --- Auth enforcement for POST requests ---
    if (req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      // Also accept Anthropic's x-api-key header (used by Claude CLI --bare mode)
      const xApiKey = req.headers['x-api-key'] || '';
      const providedKey = bearerKey || xApiKey;
      if (providedKey !== AUTH_KEY) {
        safeEnd(res, 401, { error: { message: 'Unauthorized. Provide Authorization: Bearer <key> or x-api-key: <key> header.' } });
        return;
      }
    }

    // --- GET routes ---
    if (req.method === 'GET') {
      if (req.url === '/health') {
        const status = getPoolStatus();
        safeEnd(res, 200, {
          status: status.available > 0 ? 'ok' : (status.total > 0 ? 'degraded' : 'no_tokens'),
          version: VERSION,
          backend: 'direct-api',
          claudeCodeVersion: VERSION,
          ...getDeployStatus(),
          pool: {
            total: status.total,
            available: status.available,
            cooldown: status.cooldown,
            dead: status.dead,
            byProvider: status.byProvider,
          },
          setup: status.total === 0 ? {
            anthropic: 'Add OAuth token to auth-profiles.json or set SUBSTATION_OAUTH_TOKEN',
            openai: 'Run "substation-auth chatgpt"',
          } : undefined,
        });
        return;
      }

      if (req.url === '/pool') {
        safeEnd(res, 200, { ...getPoolStatus(), ...getDeployStatus() });
        return;
      }

      if (req.url === '/v1/models' || req.url === '/models') {
        const models = [
          { id: 'fable-5-1', object: 'model', owned_by: 'indigo-collective' },
          { id: 'opus-5-5', object: 'model', owned_by: 'indigo-collective' },
          { id: 'opus-5', object: 'model', owned_by: 'indigo-collective' },
          { id: 'sonnet-5-5', object: 'model', owned_by: 'indigo-collective' },
          { id: 'sonnet-5', object: 'model', owned_by: 'indigo-collective' },
          { id: 'fable-5', object: 'model', owned_by: 'indigo-collective' },
          { id: 'opus-4-8', object: 'model', owned_by: 'indigo-collective' },
          { id: 'opus-4-7', object: 'model', owned_by: 'indigo-collective' },
          { id: 'opus-4-6', object: 'model', owned_by: 'indigo-collective' },
          { id: 'sonnet-4-6', object: 'model', owned_by: 'indigo-collective' },
          { id: 'haiku-4-5', object: 'model', owned_by: 'indigo-collective' },
        ];
        // Per-account variants for manual token selection
        const anthropicPoolTokens = pool.filter(t => t.provider === 'anthropic' && !t.dead);
        for (const t of anthropicPoolTokens) {
          models.push(
            { id: `fable-5-1:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `opus-5-5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `opus-5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `sonnet-5-5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `sonnet-5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `fable-5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `sonnet-4-6:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `opus-4-6:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `opus-4-7:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            { id: `opus-4-8:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
          );
        }
        if (pool.some(t => t.provider === 'openai')) {
          models.push(
            { id: 'gpt-6-astra', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-6.1-sol', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-6-sol', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-6-luna', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-6', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.4', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.4-mini', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.5', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.6-terra', object: 'model', owned_by: 'indigo-collective' },
            { id: 'terra', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.6-sol', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.6-sol-pro', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.6-pro', object: 'model', owned_by: 'indigo-collective' },
            { id: 'pro', object: 'model', owned_by: 'indigo-collective' },
            { id: 'sol-pro', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.6', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.3-codex', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.1-codex', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.1-codex-mini', object: 'model', owned_by: 'indigo-collective' },
            { id: 'gpt-5.1-codex-max', object: 'model', owned_by: 'indigo-collective' },
          );
          const openaiPoolTokens = pool.filter(t => t.provider === 'openai' && !t.dead);
          for (const t of openaiPoolTokens) {
            models.push(
              { id: `gpt-6-astra:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-6-sol:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-6-luna:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-6:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.4:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.4-mini:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.5:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.6-terra:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.6-sol:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.6-sol-pro:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.6-pro:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.6:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
              { id: `gpt-5.3-codex:${t.id}`, object: 'model', owned_by: 'indigo-collective' },
            );
          }
        }
        safeEnd(res, 200, { object: 'list', data: models });
        return;
      }

      res.writeHead(404); res.end('Not found'); return;
    }

    // --- POST /v1/chat/completions ---
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
      const bodyState = readUtf8Body(req, MAX_BODY_SIZE, () => {
        safeEnd(res, 413, { error: { message: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)` } });
        req.destroy();
      });

      req.on('end', async () => {
        if (res.headersSent) return; // body was too large
        const body = bodyState.text;

        let parsed;
        try { parsed = JSON.parse(body); } catch {
          safeEnd(res, 400, { error: { message: 'Invalid JSON in request body' } });
          return;
        }

        const { messages = [], model = 'sonnet-4-6', stream = false, tools, tool_choice } = parsed;
        const requestedReasoningEffort = resolveRequestedReasoningEffort(parsed);
        if (!messages.length) {
          safeEnd(res, 400, { error: { message: 'No messages in request — include at least one message' } });
          return;
        }

        // Tool-calling requests to Anthropic-family models bypass the Agent SDK
        // (a fixed-toolset coding-agent session that can't take arbitrary
        // caller-supplied tool schemas) and go straight to the raw Messages API.
        // No `tools` in the request → zero behavior change, same invokeModel path as before.
        const hasTools = Array.isArray(tools) && tools.length > 0;
        // Per-account suffix "model:acct2-foo" (same convention as invokeModel below) —
        // strip it for model resolution, and honor it as tokenAffinity when the
        // X-SubStation-Token header isn't already pinning a token.
        const modelColonIdx = model.indexOf(':');
        const baseModelForTools = modelColonIdx === -1 ? model : model.slice(0, modelColonIdx);
        const resolvedModelInfo = hasTools ? resolveModel(baseModelForTools) : null;
        const useAnthropicToolsPath = hasTools && resolvedModelInfo && resolvedModelInfo.provider === 'anthropic';
        // Best-effort forward for GPT/codex-family models — see buildCodexBody /
        // makeCodexRequest function_call handling. Unverified against a live
        // probe; may legitimately fail (Responses API tool support unconfirmed).
        const useCodexToolsPath = hasTools && resolvedModelInfo && resolvedModelInfo.provider !== 'anthropic';

        // Token affinity: X-SubStation-Token header routes to a specific pool token
        // "backup" = use backup OAuth token via direct API (for secondary agents)
        // Kept header-only here (unchanged) because this same value also flows
        // into invokeOpts for the plain invokeModel(...) no-tools path below,
        // which does its OWN "model:acct" colon parsing internally — pre-populating
        // it here would short-circuit that and break plain-model resolution.
        const tokenAffinity = req.headers['x-substation-token'] || null;
        // Anthropic-only pool mode: X-SubStation-No-Failover:1 rotates the WHOLE
        // Anthropic pool but never crosses over to OpenAI — surfaces the raw cap
        // instead of a disguised OpenAI answer. Orthogonal to tokenAffinity
        // (pin = one account no-failover; this = whole pool no-failover).
        const managedRetry = req.headers['x-substation-retry-budget'] === '0';
        const noFailover = managedRetry || ['1', 'true', 'yes', 'on'].includes(String(req.headers['x-substation-no-failover'] || '').toLowerCase());
        // Tools-path-only variant: same header, falling back to the colon
        // suffix (see baseModelForTools above) since the two new tools-path
        // invoke functions don't do their own colon parsing like invokeModel does.
        const toolsPathTokenAffinity = tokenAffinity || (modelColonIdx !== -1 ? model.slice(modelColonIdx + 1) : null);

        // Swap-detection guard: NOTE that this response's own top-level `model`
        // field (below, both streaming and non-streaming branches) ALWAYS
        // echoes back the REQUESTED model per OpenAI chat-completions API
        // convention -- it is NEVER proof of what actually served the request,
        // and the requested echo cannot self-verify serving identity.
        // The upstream served identity is captured from the Agent SDK init or
        // Codex Responses envelope and surfaced in the header before streaming
        // begins. Codex also includes it in the final JSON/SSE body so late
        // upstream identity can be observed after headers are already sent.
        // A mismatch is logged + counted (modelSwapCount) but never fails the
        // request -- observability only.
        const onServedModel = (servedModel) => {
          if (!res.headersSent) res.setHeader('x-substation-served-model', servedModel);
        };
        // Client-disconnect detection (WO 2026-09-25 fix2): req/res are only
        // reachable here (the dispatch handler), never inside the 5 invoke*
        // functions themselves — so a signal is built here and threaded down
        // as an extra optional param/opts field. 'close' can also fire after
        // a normal, fully-sent response, so gate on res.writableEnded to only
        // treat it as a real disconnect when we hadn't finished writing yet.
        const clientAbort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });
        const invokeOpts = { ...(managedRetry ? { retryBudget: 0 } : {}), ...(tokenAffinity ? { tokenAffinity } : {}), ...(noFailover ? { noFailover } : {}), onServedModel, reasoningEffort: requestedReasoningEffort, requestSignal: clientAbort.signal };

        const id = `chatcmpl-ss-${randomUUID().slice(0, 12)}`;
        const created = Math.floor(Date.now() / 1000);
        const correlation = usageCorrelationFromHeaders(req.headers, id);
        invokeOpts.correlation = correlation;
        invokeOpts.proxyId = id;
        res.setHeader('x-substation-request-id', id);
        logUsageJoin(correlation, { event: "proxy_start" });
        let usageProxyEnded = false;
        const usageProxyEnd = outcome => { if (!usageProxyEnded) { usageProxyEnded = true; logUsageJoin(correlation, { event: "proxy_end", http_status: res.statusCode, outcome }); } };
        res.once("finish", () => usageProxyEnd("complete"));
        res.once("close", () => usageProxyEnd(res.writableEnded ? "complete" : "client-disconnect"));


        try {
          if (stream) {
            if (useAnthropicToolsPath) {
              // Tool-calling responses aren't incrementally streamed (the SDK
              // tools bridge resolves the tool_use in one shot) — emit one
              // completed delta chunk with the full content/tool_calls, then
              // finish_reason. Uses the SDK transport (not raw REST) to dodge
              // the OAuth-edge 429; onServedModel surfaces the real served model.
              const { text, toolCalls, usage, substationUsage } = await invokeClaudeSDKWithTools(messages, tools, tool_choice, resolvedModelInfo, toolsPathTokenAffinity, onServedModel, noFailover, requestedReasoningEffort, null, clientAbort.signal, correlation);
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
              const deltaPayload = { role: 'assistant', content: text || null };
              if (toolCalls) deltaPayload.tool_calls = toolCalls;
              res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created,
                model, system_fingerprint: null,
                choices: [{ index: 0, delta: deltaPayload, logprobs: null, finish_reason: null }]
              })}\n\n`);
              res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created,
                model, system_fingerprint: null,
                choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: toolCalls ? 'tool_calls' : 'stop' }]
              })}\n\n`);
              res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], substation_usage: substationUsage })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            if (useCodexToolsPath) {
              // Best-effort GPT/codex tool-calling forward — see buildCodexBody /
              // makeCodexRequest. Text deltas still stream live; tool_calls (if
              // the backend actually returns any) are only known at the end,
              // same one-shot-completed-chunk pattern as the Anthropic tools path.
              let headersSentCx = false;
              let textSoFar = '';
              const sendCodexToolHeaders = () => {
                if (res.destroyed) return;
                if (!headersSentCx) {
                  headersSentCx = true;
                  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                  res.write(`data: ${JSON.stringify({
                    id, object: 'chat.completion.chunk', created,
                    model, system_fingerprint: null,
                    choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }]
                  })}\n\n`);
                }
              };
              sendCodexToolHeaders();
              const onDeltaCx = (delta) => {
                if (res.destroyed) return;
                textSoFar += delta;
                sendCodexToolHeaders();
                res.write(`data: ${JSON.stringify({
                  id, object: 'chat.completion.chunk', created,
                  model, system_fingerprint: null,
                  choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }]
                })}\n\n`);
              };
              const cxResult = await invokeCodex(messages, resolvedModelInfo, onDeltaCx, tools, requestedReasoningEffort, clientAbort.signal, onServedModel, invokeOpts);
              if (!headersSentCx) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                const deltaPayload = { role: 'assistant', content: cxResult.text || null };
                if (cxResult.toolCalls) deltaPayload.tool_calls = cxResult.toolCalls;
                res.write(`data: ${JSON.stringify({
                  id, object: 'chat.completion.chunk', created,
                  model, system_fingerprint: null,
                  choices: [{ index: 0, delta: deltaPayload, logprobs: null, finish_reason: null }]
                })}\n\n`);
              } else {
                if (!textSoFar && cxResult.text) {
                  res.write(`data: ${JSON.stringify({
                    id, object: 'chat.completion.chunk', created,
                    model, system_fingerprint: null,
                    choices: [{ index: 0, delta: { content: cxResult.text }, logprobs: null, finish_reason: null }]
                  })}\n\n`);
                }
                // Tool calls only known after the stream finished — emit them now.
                if (cxResult.toolCalls) {
                  res.write(`data: ${JSON.stringify({
                    id, object: 'chat.completion.chunk', created,
                    model, system_fingerprint: null,
                    choices: [{ index: 0, delta: { tool_calls: cxResult.toolCalls }, logprobs: null, finish_reason: null }]
                  })}\n\n`);
                }
              }
              res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created,
                model, system_fingerprint: null,
                ...(cxResult.servedModel ? { substation_served_model: cxResult.servedModel } : {}),
                ...(cxResult.substationUsage ? {substation_usage:cxResult.substationUsage} : {}),
                choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: cxResult.toolCalls ? 'tool_calls' : 'stop' }]
              })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            // Real-time streaming — send SSE headers immediately, pipe deltas as they arrive
            let headersSent = false;
            const onDelta = (delta) => {
              if (res.destroyed) return;
              if (!headersSent) {
                headersSent = true;
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                });
                // Send role chunk first
                res.write(`data: ${JSON.stringify({
                  id, object: 'chat.completion.chunk', created,
                  model, system_fingerprint: null,
                  choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }]
                })}\n\n`);
              }
              // Stream each delta as its own SSE chunk
              res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created,
                model, system_fingerprint: null,
                choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }]
              })}\n\n`);
            };

            const { text, usage, servedModel, substationUsage } = await invokeModel(messages, model, onDelta, invokeOpts);

            // Finish the stream
            if (!headersSent) {
              // Edge case: no deltas received, send full response as one chunk
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
              res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created,
                model, system_fingerprint: null,
                choices: [{ index: 0, delta: { role: 'assistant', content: text }, logprobs: null, finish_reason: null }]
              })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created,
              model, system_fingerprint: null,
              ...(servedModel && resolveModel(baseModelForTools).provider === 'openai' ? { substation_served_model: servedModel } : {}),
              choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]
            })}\n\n`);
            if (substationUsage) res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model,choices:[],substation_usage:substationUsage})}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else if (useAnthropicToolsPath) {
            // Non-streaming tool-calling path — SDK transport (dodges OAuth-edge
            // 429), arbitrary caller tools bridged via createSdkMcpServer.
            const { text, toolCalls, usage, substationUsage } = await invokeClaudeSDKWithTools(messages, tools, tool_choice, resolvedModelInfo, toolsPathTokenAffinity, onServedModel, noFailover, requestedReasoningEffort, null, clientAbort.signal, correlation);
            const promptTokens = usage?.input_tokens || usage?.prompt_tokens || Math.max(1, JSON.stringify(messages).split(/\s+/).length);
            const completionTokens = usage?.output_tokens || usage?.completion_tokens || Math.max(1, (text || '').split(/\s+/).length);
            const message = { role: 'assistant', content: text || null };
            if (toolCalls) message.tool_calls = toolCalls;
            safeEnd(res, 200, {
              id,
              object: 'chat.completion',
              created,
              model,
              system_fingerprint: null,
              choices: [{
                index: 0,
                message,
                logprobs: null,
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
              }],
              substation_usage: substationUsage,
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            });
          } else if (useCodexToolsPath) {
            // Non-streaming best-effort GPT/codex tool-calling path — see
            // buildCodexBody / makeCodexRequest function_call handling.
            const cxResult = await invokeCodex(messages, resolvedModelInfo, null, tools, requestedReasoningEffort, clientAbort.signal, onServedModel, invokeOpts);
            const promptTokens = cxResult.usage?.input_tokens || cxResult.usage?.prompt_tokens || Math.max(1, JSON.stringify(messages).split(/\s+/).length);
            const completionTokens = cxResult.usage?.output_tokens || cxResult.usage?.completion_tokens || Math.max(1, (cxResult.text || '').split(/\s+/).length);
            const message = { role: 'assistant', content: cxResult.text || null };
            if (cxResult.toolCalls) message.tool_calls = cxResult.toolCalls;
            safeEnd(res, 200, {
              id,
              object: 'chat.completion',
              created,
              model,
              ...(cxResult.servedModel ? { substation_served_model: cxResult.servedModel } : {}),
                ...(cxResult.substationUsage ? {substation_usage:cxResult.substationUsage} : {}),
              system_fingerprint: null,
              choices: [{
                index: 0,
                message,
                logprobs: null,
                finish_reason: cxResult.toolCalls ? 'tool_calls' : 'stop',
              }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            });
          } else {
            // Non-streaming — buffer full response
            const { text, usage, servedModel, substationUsage } = await invokeModel(messages, model, null, invokeOpts);
            const promptTokens = usage?.input_tokens || usage?.prompt_tokens || Math.max(1, JSON.stringify(messages).split(/\s+/).length);
            const completionTokens = usage?.output_tokens || usage?.completion_tokens || Math.max(1, text.split(/\s+/).length);
            safeEnd(res, 200, {
              id,
              object: 'chat.completion',
              created,
              model,
              ...(servedModel && resolveModel(baseModelForTools).provider === 'openai' ? { substation_served_model: servedModel } : {}),
              system_fingerprint: null,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: text },
                logprobs: null,
                finish_reason: 'stop',
              }],
              ...(substationUsage ? {substation_usage:substationUsage} : {}),
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            });
          }
        } catch (e) {
          log(`Error: ${e.message}`);
          const status = (e.statusCode === 429 || e.message.includes('tokens exhausted') || e.message.includes('EXHAUSTED') || e.message.includes('usage limit') || e.message.includes('cooldown')) ? 429 : e.message.includes('Agent SDK timeout') ? 504 : 502;
          if (resolveModel(baseModelForTools).provider !== 'openai') {
          if (!res.headersSent) {
            if (status === 429 && e.retryAfterSec) {
              res.setHeader('Retry-After', String(e.retryAfterSec));
            } else if (status === 429) {
              res.setHeader('Retry-After', '60');
            }
            safeEnd(res, status, { error: { message: e.message }, ...(e.substationUsage ? { substation_usage: e.substationUsage } : {}) });
          } else {
            // Already streaming. Some OpenAI-compatible clients ignore raw
            // `error` SSE payloads after a 200, so surface the blocker as a
            // normal assistant content chunk before closing.
            res.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created,
              model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: `BLOCKED: upstream model failed: ${e.message}` }, logprobs: null, finish_reason: null }]
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created,
              model, system_fingerprint: null,
              choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
            return;
          }
          usageProxyEnd('error');
          const envelope = upstreamErrorEnvelope(e, id);
          if (!res.headersSent) {
            if (status === 429) res.setHeader('Retry-After', String(e.retryAfterSec || 60));
            safeEnd(res, status, envelope);
          } else if (!res.destroyed && !res.writableEnded) {
            // The SDK recognizes a top-level error as failure after HTTP200.
            // Never bless it with assistant content, stop, or [DONE].
            res.write(`data: ${JSON.stringify(envelope)}\n\n`);
            res.end();
          }
        }
      });

      req.on('error', () => {
        safeEnd(res, 400, { error: { message: 'Request stream error' } });
      });

      return;
    }

    // --- POST /v1/messages — Transparent Anthropic API proxy ---
    // Used by external agents via anthropic Python SDK
    // Forwards requests as-is to api.anthropic.com with pool token injection
    if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/messages')) {
      const bodyState = readUtf8Body(req, MAX_BODY_SIZE, () => {
        safeEnd(res, 413, { error: { type: 'error', message: 'Request body too large' } });
        req.destroy();
      });

      req.on('end', async () => {
        if (res.headersSent) return;
        const body = bodyState.text;

        // Select token: round-robin by default, or specific token via header
        const tokenAffinity = req.headers['x-substation-token'];
        let targetToken = null;

        if (tokenAffinity) {
          const anthropicTokens = pool.filter(t => t.provider === 'anthropic' && !t.dead);
          targetToken = anthropicTokens.find(t => t.id === tokenAffinity || t.id.includes(tokenAffinity));
        }
        if (!targetToken) targetToken = selectAnthropicToken();

        if (!targetToken) {
          safeEnd(res, 503, { type: 'error', error: { type: 'overloaded_error', message: 'No Anthropic tokens available' } });
          return;
        }

        log(`Anthropic proxy (token=${targetToken.id}, body=${body.length}b)`);
        markRequestStart(targetToken);

        // Best-effort, non-blocking extraction of the requested model for the
        // swap-detection tee below. Regex, not JSON.parse -- this passthrough
        // deliberately never parses the body (see startProxy() docs), and a
        // malformed/huge body must never throw or slow down the real proxy.
        let requestedModelForSwapCheck = null;
        try {
          const reqModelMatch = body.match(/"model"\s*:\s*"([^"]+)"/);
          requestedModelForSwapCheck = reqModelMatch ? reqModelMatch[1] : null;
        } catch {}

        // Forward to Anthropic API — transparent passthrough
        const proxyHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetToken.token}`,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          'anthropic-client-type': 'claude-code',
          'anthropic-client-version': '2.1.197',
          'User-Agent': 'claude-code/2.1.197',
          'Content-Length': Buffer.byteLength(body),
        };
        // Forward anthropic-beta header if present
        if (req.headers['anthropic-beta']) {
          proxyHeaders['anthropic-beta'] = req.headers['anthropic-beta'];
        } else {
          proxyHeaders['anthropic-beta'] = ANTHROPIC_BETA_HEADERS;
        }

        const proxyReq = httpsRequest({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: proxyHeaders,
        }, (proxyRes) => {
          // Pipe response back to client — transparent passthrough
          const statusCode = proxyRes.statusCode;
          const respHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (k.startsWith('content-type') || k.startsWith('anthropic') || k === 'retry-after') {
              respHeaders[k] = v;
            }
          }
          res.writeHead(statusCode, respHeaders);
          proxyRes.pipe(res);

          // Swap-detection guard (read-only tee, never alters the passthrough
          // bytes going to the client -- .pipe() and this .on('data', ...)
          // listener both receive every chunk independently). Unlike
          // /v1/chat/completions, the real served model IS knowable here:
          // Anthropic's Messages API always includes a top-level `"model"`
          // field (present early in both streaming and non-streaming
          // responses), so a lightweight regex peek at the first few KB is
          // enough -- no full JSON parse needed, and it never blocks/delays
          // the real response. Logs + counts on mismatch only; never fails.
          if (requestedModelForSwapCheck) {
            let peekBuf = '';
            let modelChecked = false;
            proxyRes.on('data', (chunk) => {
              if (modelChecked) return;
              peekBuf += chunk.toString('utf8');
              if (peekBuf.length > 8192) { modelChecked = true; return; } // give up, avoid unbounded growth
              const m = peekBuf.match(/"model"\s*:\s*"([^"]+)"/);
              if (m) {
                modelChecked = true;
                const servedModel = m[1];
                if (servedModel !== requestedModelForSwapCheck) {
                  modelSwapCount++;
                  log(`WARN: /v1/messages model swap detected -- requested "${requestedModelForSwapCheck}" but Anthropic served "${servedModel}" (token=${targetToken.id}, swapCount=${modelSwapCount})`);
                }
              }
            });
          }

          proxyRes.on('end', () => {
            if (statusCode >= 200 && statusCode < 300) {
              recordUsageHeaders(targetToken, proxyRes.headers);
              markSuccess(targetToken);
            } else if (statusCode === 429) {
              markRateLimited(targetToken, parseInt(proxyRes.headers['retry-after'] || '60', 10));
            } else if (statusCode === 401) {
              markDead(targetToken);
            } else {
              markRequestEnd(targetToken);
            }
          });
        });

        proxyReq.on('error', (e) => {
          markRequestEnd(targetToken);
          log(`Anthropic proxy error: ${e.message}`);
          if (!res.headersSent) {
            safeEnd(res, 502, { type: 'error', error: { type: 'api_error', message: `Proxy error: ${e.message}` } });
          }
        });

        const timer = setTimeout(() => {
          proxyReq.destroy();
          markRequestEnd(targetToken);
          if (!res.headersSent) {
            safeEnd(res, 504, { type: 'error', error: { type: 'timeout_error', message: 'Anthropic proxy request timed out' } });
          }
        }, TIMEOUT);
        proxyReq.on('close', () => clearTimeout(timer));

        proxyReq.write(body);
        proxyReq.end();
      });

      req.on('error', () => {
        safeEnd(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Request stream error' } });
      });

      return;
    }

    // --- POST /v1/images/generations — ChatGPT conversation API image proxy ---
    if (req.method === 'POST' && (req.url === '/v1/images/generations' || req.url === '/images/generations')) {
      const bodyState = readUtf8Body(req, MAX_BODY_SIZE, () => {
        safeEnd(res, 413, { error: { message: 'Request body too large' } });
        req.destroy();
      });

      req.on('end', async () => {
        if (res.headersSent) return;
        const body = bodyState.text;

        let parsed;
        try { parsed = JSON.parse(body); } catch {
          safeEnd(res, 400, { error: { message: 'Invalid JSON in request body' } });
          return;
        }

        // quality default matches chatgptImageGenerate's own default ('high' as of
        // 2026-07-09) -- this route ALWAYS passes quality explicitly to that function
        // below, so this default (not the function's) is what actually governs real
        // requests that omit the field. Keep both in sync.
        const { prompt, model: _reqModel, size = '1024x1024', quality = 'high', n = 1, image } = parsed;
        if (!prompt) {
          safeEnd(res, 400, { error: { message: 'Missing required field: prompt' } });
          return;
        }

        let imageParts;
        try { imageParts = resolveImageRefs(image); } catch (e) {
          safeEnd(res, 400, { error: { message: e.message } });
          return;
        }

        const tokenEntry = selectToken('openai');
        if (!tokenEntry) {
          safeEnd(res, 503, { error: { message: 'No OpenAI tokens available — run "substation-auth chatgpt" to add one' } });
          return;
        }

        log(`Image gen request (token=${tokenEntry.id}, prompt="${prompt.slice(0, 80)}...", refs=${imageParts.length})`);
        markRequestStart(tokenEntry);

        try {
          const results = [];
          for (let i = 0; i < Math.min(n, 4); i++) {
            const result = await chatgptImageGenerate(tokenEntry, prompt, size, quality, imageParts);
            // result.b64 is already base64 from the Codex/Responses API stream
            results.push({ b64: result.b64, revised_prompt: prompt });
          }

          markSuccess(tokenEntry);

          safeEnd(res, 200, {
            created: Math.floor(Date.now() / 1000),
            data: results.map(r => ({ b64_json: r.b64, revised_prompt: r.revised_prompt })),
          });
        } catch (err) {
          markRequestEnd(tokenEntry);
          log(`Image gen error: ${err.message}`);

          // On 401/403 — try refreshing the token before giving up (matches text model behavior)
          if ((err.statusCode === 401 || err.statusCode === 403) && tokenEntry.refreshToken) {
            try {
              log(`Image gen: token ${tokenEntry.id} got ${err.statusCode}, attempting refresh...`);
              await refreshOpenAIToken(tokenEntry);
              markRequestStart(tokenEntry);
              const results = [];
              for (let i = 0; i < Math.min(n, 4); i++) {
                const result = await chatgptImageGenerate(tokenEntry, prompt, size, quality, imageParts);
                results.push({ b64: result.b64, revised_prompt: prompt });
              }
              markSuccess(tokenEntry);
              safeEnd(res, 200, {
                created: Math.floor(Date.now() / 1000),
                data: results.map(r => ({ b64_json: r.b64, revised_prompt: r.revised_prompt })),
              });
              return;
            } catch (refreshErr) {
              log(`Image gen: refresh failed for ${tokenEntry.id}: ${refreshErr.message}`);
              markDead(tokenEntry);
            }
          } else if (err.statusCode === 401 || err.statusCode === 403) {
            markDead(tokenEntry);
          }

          if (!res.headersSent) {
            safeEnd(res, err.statusCode && err.statusCode >= 400 ? err.statusCode : 502, {
              error: { message: `Image generation failed: ${err.message}` },
            });
          }
        }
      });

      req.on('error', () => {
        safeEnd(res, 400, { error: { message: 'Request stream error' } });
      });

      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  // Handle server errors
  let bindRetries = 0;
  const MAX_BIND_RETRIES = 3;
  proxyServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      bindRetries++;
      if (bindRetries > MAX_BIND_RETRIES) {
        log(`ERROR: Port ${PORT} still in use after ${MAX_BIND_RETRIES} retries. Kill the process manually: /usr/sbin/lsof -ti :${PORT} | xargs kill`);
        return;
      }
      log(`Port ${PORT} in use — attempting to free it (attempt ${bindRetries}/${MAX_BIND_RETRIES})...`);
      if (killStaleProcess(PORT)) {
        log('Stale process killed, retrying bind...');
        setTimeout(() => {
          try { proxyServer.close(); } catch {}
          proxyServer.listen(PORT, '127.0.0.1');
        }, 1000);
      } else {
        log(`ERROR: Could not free port ${PORT}. Kill the process manually: /usr/sbin/lsof -ti :${PORT} | xargs kill`);
      }
    } else {
      log(`Server error: ${err.message}`);
    }
  });

  // Handle client connection errors (prevent EPIPE crashes)
  proxyServer.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  proxyServer.listen(PORT, '127.0.0.1', () => {
    const status = getPoolStatus();
    log(`SubStation v${VERSION} on http://127.0.0.1:${PORT} (pool=${status.total}, anthropic=${status.byProvider.anthropic}, openai=${status.byProvider.openai}, cc=${VERSION})`);
    startUsageProbeLoop();
  });

  function gracefulShutdown() {
    log('shutting down gracefully...');
    proxyServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      log('forcing exit after 10s timeout');
      process.exit(0);
    }, 10000).unref();
  }
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS = [
  {
    id: 'fable-5-1',
    name: 'Claude Fable 5.1 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'opus-5-5',
    name: 'Claude Opus 5.5 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'opus-5',
    name: 'Claude Opus 5 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'sonnet-5-5',
    name: 'Claude Sonnet 5.5 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'sonnet-5',
    name: 'Claude Sonnet 5 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'fable-5',
    name: 'Claude Fable 5 (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'opus-4-8',
    name: 'Claude Opus 4.8 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'opus-4-7',
    name: 'Claude Opus 4.7 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'opus-4-6',
    name: 'Claude Opus 4.6 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: 'sonnet-4-6',
    name: 'Claude Sonnet 4.6 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: 'haiku-4-5',
    name: 'Claude Haiku 4.5 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
];

const OPENAI_MODELS = [
  {
    id: 'gpt-6.1-sol',
    name: 'GPT 6.1 Sol (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT 6 Astra (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-6-sol',
    name: 'GPT 6 Sol (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT 6 Luna (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 64000,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT 5.5 (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT 5.6 Terra (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol Pro (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.6-sol-pro',
    name: 'GPT 5.6 Sol Pro Explicit (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.6-pro',
    name: 'GPT 5.6 Pro Alias (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.6',
    name: 'GPT 5.6 / Sol Pro Alias (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT 5.3 Codex (SubStation)',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT 5.1 Codex (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT 5.1 Codex Mini (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 64000,
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT 5.1 Codex Max (SubStation)',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
];

function getAllModels() {
  const models = [...ANTHROPIC_MODELS];
  // Per-account pinned variants: "opus-4-6:acct2-yourname" routes to that specific token
  const anthropicPoolTokens = pool.filter(t => t.provider === 'anthropic' && !t.dead);
  for (const t of anthropicPoolTokens) {
    models.push(
      { id: `fable-5-1:${t.id}`, name: `Fable 5.1 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `opus-5-5:${t.id}`, name: `Opus 5.5 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `opus-5:${t.id}`, name: `Opus 5 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `sonnet-5-5:${t.id}`, name: `Sonnet 5.5 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `sonnet-5:${t.id}`, name: `Sonnet 5 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `fable-5:${t.id}`, name: `Fable 5 — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `opus-4-8:${t.id}`, name: `Opus 4.8 — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `opus-4-6:${t.id}`, name: `Opus 4.6 — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 },
      { id: `sonnet-4-6:${t.id}`, name: `Sonnet 4.6 — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 64000 },
    );
  }
  if (pool.some(t => t.provider === 'openai')) {
    models.push(...OPENAI_MODELS);
    // Per-account pinned ChatGPT variants
    const openaiPoolTokens = pool.filter(t => t.provider === 'openai' && !t.dead);
    for (const t of openaiPoolTokens) {
      models.push(
        { id: `gpt-6-astra:${t.id}`, name: `GPT 6 Astra — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-6-sol:${t.id}`, name: `GPT 6 Sol — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-6-luna:${t.id}`, name: `GPT 6 Luna — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.4:${t.id}`, name: `GPT 5.4 — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 },
        { id: `gpt-5.4-mini:${t.id}`, name: `GPT 5.4 Mini — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 64000 },
        { id: `gpt-5.5:${t.id}`, name: `GPT 5.5 — ${t.id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 },
        { id: `gpt-5.6-terra:${t.id}`, name: `GPT 5.6 Terra — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.6-sol:${t.id}`, name: `GPT 5.6 Sol Pro — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.6-sol-pro:${t.id}`, name: `GPT 5.6 Sol Pro Explicit — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.6-pro:${t.id}`, name: `GPT 5.6 Pro Alias — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.6:${t.id}`, name: `GPT 5.6 / Sol Pro Alias — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1050000, maxTokens: 128000 },
        { id: `gpt-5.3-codex:${t.id}`, name: `GPT 5.3 Codex — ${t.id}`, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 },
      );
    }
  }
  return models;
}

function buildProviderModels(baseUrl) {
  return {
    baseUrl,
    apiKey: 'sk-substation-local-proxy',
    api: 'openai-completions',
    models: getAllModels(),
  };
}

const indigoProvider = {
  id: 'indigo',
  label: 'Indigo (SubStation)',
  docsPath: 'https://indigocollective.dev/substation',
  aliases: ['substation', 'ss'],
  envVars: [],
  get models() {
    return buildProviderModels(`http://127.0.0.1:${PORT}/v1`);
  },
  auth: [],
};

export {
  log,
  sdkConfigDirForToken,
  readUtf8Body,
  getDeployStatus,
  resolveModel,
  usageCorrelationFromHeaders,
  sdkUsageRow,
  sdkCacheUsage,
  invokeWarmSummary,
  measuredOpenAIUsage,
  combineMeasuredUsage,
  invokeClaudeSDKWithTools,
  invokeClaudeSDK,
  invokeClaudeDirect,
  invokeClaudeMessagesAPIWithTools,
  enforceToolProgress,
  normalizeToolCalls,
  progressTracker,
  appendAliasNote,
  hashMessagesPrefix,
  progressSessionKey,
  formatMessagesForSDK,
  formatStableMessagesForSDK,
  sdkPromptFromBlocks,
  formatTailForSDK,
  scrubSdkNoiseTurns,
  scrubNoResponseOutput,
  isBareNoResponseText,
  isBareContinueNudgeText,
  sdkResumeCache,
  normalizeReasoningEffort,
  resolveRequestedReasoningEffort,
  resolveClaudeReasoningEffort,
  resolveCodexReasoningEffort,
  buildAnthropicBody,
  buildCodexBody,
  getCodexServedModel,
};

export default {
  id: 'substation',
  name: 'SubStation',
  description: 'Route through Claude Max + ChatGPT Pro subscriptions — zero API cost',
  register(api) {
    log('SubStation plugin registering...');

    startProxy();

    api.registerProvider(indigoProvider);

    if (!api.config.models) api.config.models = { providers: {} };
    if (!api.config.models.providers) api.config.models.providers = {};

    api.config.models.providers.indigo = {
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      api: 'openai-completions',
      apiKey: 'sk-substation-local-proxy',
      models: getAllModels(),
    };

    api.logger.info(`SubStation v${VERSION} registered (${getAllModels().length} models via direct API)`);
    log(`SubStation plugin registered — ${getAllModels().length} models, ${pool.length} tokens`);
  },
};

// Standalone mode: if run directly (not imported as plugin), start the proxy server
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  log(`SubStation v${VERSION} starting in standalone mode...`);
  startProxy();
}

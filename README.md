<div align="center">

<h1>SubStation</h1>

<p><strong>$400/month in AI subscriptions.<br>And they still charge you per token.</strong></p>

<p>SubStation plugs into your Claude Max and ChatGPT Pro accounts and routes every request through what you already paid for. Your agent gets Opus, Sonnet, GPT-5.4, Codex. Your API bill stays at zero.</p>

<br>

<img src="https://img.shields.io/badge/💰_Zero_API_Cost-black?style=for-the-badge" alt="Zero API cost">&nbsp;
<img src="https://img.shields.io/badge/🔄_Multi--Account_Pool-blue?style=for-the-badge" alt="Multi-account pool">&nbsp;
<img src="https://img.shields.io/badge/⚡_Persistent_Sessions-yellow?style=for-the-badge" alt="Persistent sessions">&nbsp;
<img src="https://img.shields.io/badge/🔒_Privacy--First-green?style=for-the-badge" alt="Privacy first">

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange?style=flat-square)](https://openclaw.ai)

</div>

---

## The math nobody talks about

Claude Max: **$200/mo**. ChatGPT Pro: **$200/mo**. That's $4,800/year for unlimited access.

Then you spin up an agent. Suddenly it's $0.015 per 1K output tokens on Opus. $0.01 on GPT-5.4. Run a few hundred requests a day and your API bill dwarfs the subscriptions you're already paying.

**SubStation makes those subscriptions work twice.** One copy for you. One copy for your agents. Same tokens, same accounts, same access. The API never gets involved.

---

## How it works

```
OpenClaw
  |
  v
SubStation (:8403)
  |
  +-- Claude (Opus, Sonnet, Haiku)
  |     Session stays alive. Sub-second after first spawn.
  |
  +-- ChatGPT (GPT-5.4, Codex)
        Token-by-token streaming. No buffering.
```

**Claude** routes through the Agent SDK using your Claude Max OAuth tokens. Each request runs inside a real process. Sessions persist, so you only pay the cold start once.

**ChatGPT** routes through the Codex API using your ChatGPT Pro/Plus OAuth tokens. SSE streaming pipes every token the moment it's generated.

Both providers support **multi-account credential pools**. Add two accounts, five accounts, ten. SubStation rotates between them automatically based on who was used least recently. Hit a rate limit on one? The next token picks up before the user notices.

---

## What you get

| | |
|---|---|
| **Multi-account rotation** | Pool your OAuth tokens across accounts. LRU selection keeps usage distributed. Hit a 429, the next account picks up instantly |
| **Persistent sessions** | Claude sessions stay warm. First request spawns the process. Every request after that: sub-second |
| **Real-time streaming** | Not buffered. Not batched. Every token piped the moment the provider generates it |
| **Auto-failover** | Rate limit on one token triggers silent rotation to the next. All tokens exhausted? Then (and only then) you get a 429 |
| **Token refresh** | ChatGPT OAuth tokens auto-refresh. No manual intervention |
| **Nothing leaves your machine** | No message logging. No telemetry. No analytics. Requests proxy through and disappear |

---

## 12 models, 2 providers, 0 API cost

| Provider | Model ID | What you get |
|----------|----------|------|
| Claude | `fable-5` | Claude Fable 5, 1M context |
| Claude | `opus-4-8` | Claude Opus 4.8, 1M context |
| Claude | `opus-4-7` | Claude Opus 4.7, 1M context |
| Claude | `opus-4-6` | Claude Opus 4.6, 1M context |
| Claude | `sonnet-5` | Claude Sonnet 5, latest — 1M context |
| Claude | `sonnet-4-6` | Claude Sonnet 4.6, 1M context |
| Claude | `haiku-4-5` | Claude Haiku 4.5, 1M context |
| ChatGPT | `gpt-5.4` | GPT 5.4, 200K context |
| ChatGPT | `gpt-5.4-mini` | GPT 5.4 Mini, 200K context |
| ChatGPT | `gpt-5.1-codex` | GPT 5.1 Codex |
| ChatGPT | `gpt-5.1-codex-mini` | GPT 5.1 Codex Mini |
| ChatGPT | `gpt-5.1-codex-max` | GPT 5.1 Codex Max |

### Model aliases

Every model accepts short aliases — `fable` and `fable-5` both resolve to `claude-fable-5`; `opus-4-8` resolves to `claude-opus-4-8`; `codex`, `codex-mini`, and `codex-max` map to the `gpt-5.1-codex*` family. Provider prefixes like `indigo/opus-4-6` are stripped automatically. Unknown models fall back to Sonnet.

You can also pin a request to a specific account in your pool with a suffix: `opus-4-6:acct2-alice` routes to the token whose `id` is `acct2-alice` instead of letting LRU rotation pick. `GET /v1/models` lists every alias and per-account variant.

If all Anthropic tokens are cooling down, SubStation can fail over to an equivalent OpenAI model (e.g. `fable-5` → `gpt-5.4`) when ChatGPT tokens are in the pool.

---

## 5-minute setup

### 1. Install

```bash
mkdir -p ~/.openclaw/extensions/substation/dist
cp src/index.js ~/.openclaw/extensions/substation/dist/index.js
cp openclaw.plugin.json ~/.openclaw/extensions/substation/
cp package.json ~/.openclaw/extensions/substation/

cd ~/.openclaw/extensions/substation
npm install @anthropic-ai/claude-agent-sdk
```

### 2. Add your Claude Max tokens

SubStation reads Anthropic OAuth tokens from OpenClaw's auth-profiles:

```
~/.openclaw/agents/main/agent/auth-profiles.json
```

Add one or more `anthropic:*` profiles with `"type": "token"` and your OAuth token. Multiple accounts? Add them all. SubStation auto-detects and rotates.

### 3. Add ChatGPT tokens (optional)

```bash
node scripts/substation-auth chatgpt
```

Opens your browser, runs the OAuth PKCE flow, saves tokens to `~/.substation/token-pool.json`. Run it once per account.

```bash
node scripts/substation-auth status   # see what's healthy
```

### 4. Configure OpenClaw

Add SubStation as a provider in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "substation": {
        "baseUrl": "http://127.0.0.1:8403/v1",
        "apiKey": "substation-local",
        "api": "openai-completions",
        "models": [
          { "id": "opus-4-6", "name": "Claude Opus 4.6 (SubStation)", "contextWindow": 200000, "maxTokens": 128000 },
          { "id": "sonnet-5", "name": "Claude Sonnet 5 (SubStation)", "contextWindow": 200000, "maxTokens": 64000 },
          { "id": "sonnet-4-6", "name": "Claude Sonnet 4.6 (SubStation)", "contextWindow": 200000, "maxTokens": 64000 },
          { "id": "haiku-4-5", "name": "Claude Haiku 4.5 (SubStation)", "contextWindow": 200000, "maxTokens": 64000 },
          { "id": "gpt-5.4", "name": "GPT 5.4 (SubStation)", "contextWindow": 200000, "maxTokens": 128000 },
          { "id": "gpt-5.4-mini", "name": "GPT 5.4 Mini (SubStation)", "contextWindow": 200000, "maxTokens": 64000 }
        ]
      }
    }
  }
}
```

### 5. Restart OpenClaw

Models show up in the `/model` picker. Pick one. That's it. Every request now routes through your subscriptions.

---

## Endpoints

| Endpoint | What it does |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat completions proxy |
| `GET /v1/models` | Lists every model SubStation can route to |
| `GET /health` | Pool status, version, token counts per provider |
| `GET /pool` | Per-token status: last used, cooldowns, errors |

---

## Where tokens come from

SubStation loads from several sources at startup (deduplicates automatically):

1. **`~/.substation/token-pool.json`** — your credential pool (Anthropic and/or ChatGPT entries). See `token-pool.example.json` in this repo for the format; copy it to `~/.substation/token-pool.json` and fill in your own tokens
2. **`auth-profiles.json`** — every `anthropic:*` profile with a `.token` field (`~/.claude/auth-profiles.json` by default; override with `SUBSTATION_AUTH_PROFILES`, add a second file via `SUBSTATION_SECONDARY_AUTH_PROFILES`)
3. **`SUBSTATION_OAUTH_TOKENS`** env var, comma-separated (also `SUBSTATION_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` for a single token)

The pool file hot-reloads — add an account, no restart needed. Runtime state (pool state, logs) lives in `~/.substation/`. No credentials ship with this repo; you bring your own.

### Run standalone

```bash
npm install
node src/index.js                        # serves http://127.0.0.1:8403
SUBSTATION_PORT=9000 node src/index.js   # custom port
```

Clients authenticate with any `Authorization: Bearer <key>` (or `x-api-key`) matching `SUBSTATION_API_KEY` — default `sk-substation-local-proxy`; the server binds to 127.0.0.1 only.

---

## Privacy

Your data never touches a third party. SubStation proxies requests and discards them. No message content is stored. No message content is logged. Token IDs (not values) appear in logs for debugging. No telemetry. No analytics. Everything stays on your machine.

---

## License

MIT

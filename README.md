# Twitter (X) Agent

A Primordial agent that searches and reads **public** X (Twitter) using xAI
Grok's server-side `x_search` tool.

## What it does

Three modes, selected via the `mode` input:

| Mode | Use it for |
|------|------------|
| `search_tweets` *(default)* | Semantic search for posts on a topic — by meaning, not just literal keywords. Returns the most relevant posts grouped by theme/stance. |
| `search_accounts` | Discover the most relevant **accounts/handles** for a topic and what each posts about. |
| `trending` | Summarize what's being discussed **right now** on a topic — dominant narratives, who's driving the conversation, emerging consensus or splits. |

Grok runs the search server-side and returns a synthesized answer; the agent
appends a `Sources:` section with links to the originating posts.

> **Scope:** Public X only. This agent cannot read a private home / "For You"
> timeline — that requires authenticated account access, which is out of scope
> by design.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `query` | yes | What to find, in natural language. |
| `mode` | no | `search_tweets` (default), `search_accounts`, or `trending`. |
| `handles` | no | Comma-separated handles to restrict to (max 20; `@` optional). |
| `exclude_handles` | no | Comma-separated handles to exclude (max 20). |
| `from_date` | no | Earliest post date, `YYYY-MM-DD`. |
| `to_date` | no | Latest post date, `YYYY-MM-DD`. |

## Output

`response` — Grok's answer with handles referenced inline, followed by a
`Sources:` list of the X posts that back it.

## Keys

Requires an **xAI (Grok)** key. `xai` is a Primordial known provider, so the
manifest declares only `provider: xai`. The security proxy injects the real
key and exposes `XAI_API_KEY` (session token) + `XAI_BASE_URL` (localhost) to
the agent.

## Build

```bash
npm install
npm run build        # esbuild -> bundle.mjs (single ESM file, zero runtime deps)
```

The Primordial sandbox runs `npm install && npm run build` on startup, then
executes `node bundle.mjs`.

## Examples

```jsonc
// Semantic tweet search
{"inputs": {"query": "strongest arguments against the new EU AI rules"}}

// Restrict to specific accounts, recent window
{"inputs": {"query": "small-model fine-tuning tips", "handles": "karpathy,sama",
            "from_date": "2026-05-01"}}

// Find accounts
{"inputs": {"query": "real-time robotics control research", "mode": "search_accounts"}}

// What's happening now
{"inputs": {"query": "the latest React release", "mode": "trending"}}
```

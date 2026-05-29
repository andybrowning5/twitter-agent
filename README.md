# Twitter (X) Research Agent

A Primordial **research** agent that searches and reads **public** X (Twitter)
using xAI Grok's server-side search tools. Built to be called by another program
(often Claude Code doing research): every answer is structured, inline-cited
Markdown with a strict honesty contract.

## What it does

Four modes, selected via the `mode` input:

| Mode | Use it for |
|------|------------|
| `search_tweets` *(default)* | Semantic search for posts on a topic — by meaning, not literal keywords. Auto-groups by stance for debates (`### Supportive/Critical/Mixed`) or by failure mode for release/bug intel. |
| `search_accounts` | Discover the most relevant **accounts/handles** for a topic, ranked by originality → how often they're cited → recency. |
| `trending` | What's being discussed **right now**, each thread tagged `active` / `resolved` / `unclear` (resolution beats age). Auto-windows to the last 3 days. |
| `expert_opinions` | For a **system / architecture / tech-choice** decision: how credible practitioners actually lean, the tradeoff axes they raise, and real prod reports — cross-checked against engineering blogs and docs. |

`trending` and `expert_opinions` also use `web_search` alongside `x_search` to
cross-check claims and verify sources. `search_tweets` and `search_accounts`
stay X-only.

> **Scope:** Public X only. This agent cannot read a private home / "For You"
> timeline — that requires authenticated account access, out of scope by design.

## Output contract

Grok runs the search server-side and returns one synthesized answer. The agent
shapes it into:

- `## Summary` — the headline answer (2-3 sentences).
- Mode-specific sections — `## Findings` / `## Accounts` / `## Threads` / the
  `expert_opinions` decision sections.
- `## Coverage` — how much signal was found, the date window, and caveats.
- `## Sources` — appended from citations, each labeled `[X]` or `[web]`.

Honesty rules baked into the prompt: quotes are **verbatim or omitted**, unknown
fields are `—` (never guessed), author identity is flagged
`model says: … (unverified)`, no manufactured balance, no fabricated
percentages, and it **presents evidence rather than deciding for you**.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `query` | yes | What to find, in natural language. |
| `mode` | no | `search_tweets` (default), `search_accounts`, `trending`, `expert_opinions`. |
| `handles` | no | Comma-separated handles (max 20; `@` optional). **Restricts to ONLY these accounts** — it does not boost them. Leave empty to search all of X. |
| `exclude_handles` | no | Comma-separated handles to exclude (max 20). |
| `from_date` | no | Earliest post date, `YYYY-MM-DD`. Overrides the trending auto-window. |
| `to_date` | no | Latest post date, `YYYY-MM-DD`. |

## Output

`response` — structured Markdown as described in **Output contract** above.

## Keys

Requires an **xAI (Grok)** key. `xai` is a Primordial known provider, so the
manifest declares only `provider: xai`. The security proxy injects the real key
and exposes `XAI_API_KEY` (session token) + `XAI_BASE_URL` (localhost) to the
agent. `web_search` runs inside Grok, so no extra key/domain is needed.

## Build

```bash
npm install
npm run build        # esbuild -> bundle.mjs (single ESM file, zero runtime deps)
```

The committed `bundle.mjs` lets the sandbox skip the build; `setup_command` only
rebuilds if it's missing. The sandbox then runs `node bundle.mjs`.

## Examples

```jsonc
// Semantic tweet search (debate → grouped by stance)
{"inputs": {"query": "is rewriting our backend in Rust worth it"}}

// Find accounts
{"inputs": {"query": "real-time robotics control research", "mode": "search_accounts"}}

// What's happening now (auto last-3-days window, active/resolved status)
{"inputs": {"query": "OpenAI API outage", "mode": "trending"}}

// Architecture decision — how practitioners lean, with web cross-check
{"inputs": {"query": "Postgres vs MongoDB for a multi-tenant SaaS at scale",
            "mode": "expert_opinions"}}

// Restrict to specific accounts, recent window
{"inputs": {"query": "small-model fine-tuning tips", "handles": "karpathy,sama",
            "from_date": "2026-05-01"}}
```

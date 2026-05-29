# CLAUDE.md — Twitter (X) Research Agent

Developer guidelines for working on the Twitter (X) Research Agent.

## Purpose

A **research** agent for **public** X (Twitter) via xAI Grok's server-side
search tools, designed to be called by another program (often Claude Code). The
behavioral contract is fixed:

- Public X only. No private home timeline, no authenticated-account features.
- Four modes: `search_tweets`, `search_accounts`, `trending`, `expert_opinions`.
- Always ground answers in real results — never fabricate posts, handles,
  quotes, numbers, or links. Quotes are verbatim or omitted; unknown fields are
  `—`; author identity is flagged `model says: … (unverified)`; present evidence
  rather than deciding for the caller. These live in the shared `GROUNDING`
  constant in `src/agent.ts`.
- Output is structured Markdown: `## Summary` → mode sections → `## Coverage`,
  then an agent-appended `## Sources` list with `[X]`/`[web]` labels.

If a change would add private-timeline access or another data source, it does
not belong in this agent — propose a new one instead.

## Modes & tools (`src/agent.ts`)

- Mode bodies live in the `PER_MODE` record; `buildSystemPrompt` = `GROUNDING` +
  `ENVELOPE` + `PER_MODE[mode]`. Keep the shared spine in `GROUNDING`/`ENVELOPE`
  and only put mode-specific structure in `PER_MODE`.
- `buildTools(msg, mode)` returns the tools array. `x_search` is always present;
  `web_search` is added only for modes in `WEB_SEARCH_MODES` (`expert_opinions`,
  `trending`) — to cross-check claims and verify sources. The other two modes
  stay X-only on purpose.
- **Date defaults:** caller `from_date`/`to_date` always win. With neither set,
  only `trending` gets an automatic `from_date = now − 3 days` (via `isoDaysAgo`);
  other modes stay open-ended, and `to_date` is never auto-set. If you add a new
  mode, decide its date policy here explicitly.

## How it talks to xAI

- **API:** Agent Tools API at `POST {XAI_BASE_URL}/v1/responses`. This replaced
  the retired Live Search `search_parameters` API (gone since 2026-01-12).
- **Tools:** server-side entries in the `tools` array — `{"type":"x_search",...}`
  always, plus `{"type":"web_search"}` for the web-enabled modes. Grok executes
  the search itself and auto-routes across tools — there is **no** client-side
  tool loop to run. `web_search` runs inside Grok, so it needs no extra key/domain.
- **Auth/proxy:** the Primordial proxy injects the real key. The agent reads
  `XAI_API_KEY` (session token, sent as `Authorization: Bearer`) and
  `XAI_BASE_URL` (localhost proxy). Falls back to `https://api.x.ai` for local
  dry-runs outside the sandbox.
- **No SDK / no runtime deps:** uses global `fetch` (Node 20+). Keep it that way
  — the bundle should stay tiny.

## `x_search` parameters used

`allowed_x_handles`, `excluded_x_handles` (max 20 each, `@` stripped — note
these RESTRICT to only those handles, they don't boost), `from_date`, `to_date`
(`YYYY-MM-DD`), `enable_image_understanding`, `enable_video_understanding`. If
xAI adds view/favorite-count filters, thread them through `buildTools`.

## Response parsing

`output[].content[]` blocks of type `output_text` carry `text` and
`annotations[]` of type `url_citation`. Some responses also include a flat
top-level `citations` array. `extractFromResponse` handles both and dedupes by
URL — keep it defensive, the exact shape has shifted across xAI API versions.
Each citation gets a `source` (`x`/`web`): the API may supply it, otherwise
`inferSource` derives it from the URL hostname. `formatSources` renders the
`## Sources` list with a `[X]`/`[web]` tag per entry.

## Build

```bash
npm install
npm run build        # esbuild -> bundle.mjs
```

The bundle is what the sandbox executes. Source lives in `src/agent.ts`.

## Protocol

NDJSON over stdin/stdout.

```
stdout: {"type":"ready"}
stdin:  {"inputs":{"query":"...","mode":"trending","handles":"sama,karpathy"}}
stdout: {"type":"activity","tool":"x_search+web_search","description":"mode=trending ..."}
stdout: {"type":"response","content":"## Summary ... \n\n## Sources\n1. [X] ...","done":true}
```

A single CLI argument is accepted as a one-shot prompt (dry-run path). Plain
text or a `{"type":"message","content":"..."}` envelope are both accepted and
treated as the `query`.

## Model

Default model: `grok-4.3` (current Grok model that supports the Agent Tools
API). Set in both `agent.yaml` and the `MODEL` constant in `src/agent.ts`. If
you change it, change both, and confirm the new model still supports
server-side `x_search`.

## Testing

E2E without burning a real key: point `XAI_BASE_URL` at a local HTTP server
that echoes the request body and returns a canned Responses-API payload, then
run `node bundle.mjs '{"inputs":{...}}'` (one-shot) or pipe a JSON line in.
Verify per mode: the `tools` array (only `x_search` for search_tweets/
search_accounts; `x_search` + `web_search` for trending/expert_opinions), the
trending `from_date = now − 3d` default (and that a caller date overrides it),
handle parsing, that `instructions` carry the `GROUNDING` block + the right mode
block, and that `## Sources` renders with `[X]`/`[web]` labels from both
`url_citation` annotations and the flat `citations` array. Also confirm the
stdin path echoes `message_id` and exits cleanly on `{"type":"shutdown"}`.

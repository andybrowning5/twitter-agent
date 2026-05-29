# CLAUDE.md — Twitter (X) Agent

Developer guidelines for working on the Twitter (X) Agent.

## Purpose

Search and read **public** X (Twitter) via xAI Grok's server-side `x_search`
tool. The behavioral contract is fixed:

- Public X only. No private home timeline, no authenticated-account features.
- Three modes: `search_tweets`, `search_accounts`, `trending`.
- Always ground answers in real posts returned by `x_search` — never fabricate.
- Return a synthesized answer + a `Sources:` list built from citations.

If a change would add private-timeline access or another data source, it does
not belong in this agent — propose a new one instead.

## How it talks to xAI

- **API:** Agent Tools API at `POST {XAI_BASE_URL}/v1/responses`. This replaced
  the retired Live Search `search_parameters` API (gone since 2026-01-12).
- **Tool:** server-side `{"type": "x_search", ...}` in the `tools` array. Grok
  executes the search itself — there is **no** client-side tool loop to run.
- **Auth/proxy:** the Primordial proxy injects the real key. The agent reads
  `XAI_API_KEY` (session token, sent as `Authorization: Bearer`) and
  `XAI_BASE_URL` (localhost proxy). Falls back to `https://api.x.ai` for local
  dry-runs outside the sandbox.
- **No SDK / no runtime deps:** uses global `fetch` (Node 20+). Keep it that way
  — the bundle should stay tiny.

## `x_search` parameters used

`allowed_x_handles`, `excluded_x_handles` (max 20 each, `@` stripped),
`from_date`, `to_date` (`YYYY-MM-DD`), `enable_image_understanding`. If xAI adds
view/favorite-count filters, thread them through `buildXSearchTool`.

## Response parsing

`output[].content[]` blocks of type `output_text` carry `text` and
`annotations[]` of type `url_citation`. Some responses also include a flat
top-level `citations` array. `extractFromResponse` handles both and dedupes by
URL — keep it defensive, the exact shape has shifted across xAI API versions.

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
stdout: {"type":"activity","tool":"x_search","description":"mode=trending ..."}
stdout: {"type":"response","content":"... \n\nSources:\n1. ...","done":true}
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
pipe a JSON `inputs` line into `node bundle.mjs`. Verify the request includes
the `x_search` tool with the expected handle/date filters, and that the
`Sources:` section renders from both `url_citation` annotations and the flat
`citations` array.

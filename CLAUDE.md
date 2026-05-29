# CLAUDE.md — Twitter (X) Research Agent

Developer guidelines for working on the Twitter (X) Research Agent.

## Purpose

A **research** agent for **public** X (Twitter) via xAI Grok's server-side
search tools, designed to be called by another program (often Claude Code). The
behavioral contract is fixed:

- Public X only. No private home timeline, no authenticated-account features.
- Four modes: `search_tweets`, `search_accounts`, `trending`, `expert_opinions`.
- Always ground answers in real results — never fabricate posts, handles,
  quotes, numbers, or links. Every cited post is reproduced IN FULL as a verbatim
  Markdown blockquote (and the whole thread, in order, when the thread carries the
  point), with missing wording marked `[…]` rather than approximated or invented;
  unknown fields are `—`; author identity is flagged `model says: … (unverified)`;
  present evidence rather than deciding for the caller. These live in the shared
  `GROUNDING` constant in `src/agent.ts`.
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

`output[]` holds reasoning items, tool-call items (`custom_tool_call` is an
x_search call, `web_search_call` is a web call), and a final `message` item.
Only the `message`'s `output_text` block carries `annotations[]` of type
`url_citation`. Two gotchas, confirmed by dumping a real response:

- A citation's `title` is just the visible NUMBER (`"1"`, `"2"`), **not** a page
  title. `citationLabel` therefore derives the label from the URL — `@handle` for
  X posts/profiles, `post` for an opaque `x.com/i/status/<id>` tweet with no
  readable form to recover a handle from, hostname for the open web — and only
  trusts `title` when it's non-numeric (in case a future API version supplies one).
- Grok annotates only a handful of `url_citation`s even when the body references
  many sources, and `search_accounts` writes profile/post links straight into the
  prose that never become annotations. So `extractFromResponse` ALSO harvests every
  bare URL from the text via `URL_RE`. The `GROUNDING` prompt tells the model to
  write real inline source URLs precisely so this harvest has links to grab.
  `web_search_call` items do **not** expose their result URLs, so annotations +
  harvested prose URLs are the only source of truth.

The same post/account shows up in two URL shapes: the readable
`x.com/<handle>/status/<id>` and `x.com/<handle>` forms the model writes in prose,
and the opaque `x.com/i/status/<id>` / `x.com/i/user/<id>` forms xAI emits as
annotations. So `extractFromResponse` dedupes by a `citationKey` — tweet id for
posts, handle for profiles, normalized host+path for the open web — not by the raw
URL string. When both shapes of one post arrive, the readable form upgrades the
opaque one in place (`Map.set` on an existing key keeps its position). Opaque
`x.com/i/user/<id>` profile links have no handle to recover and no readable
counterpart, so `citationKey` returns `null` and they're dropped entirely. An
opaque `x.com/i/status/<id>` tweet with no readable counterpart is still a real
post, so it's kept and labeled `[X] post` rather than the bare host.

`extractFromResponse` still also reads a flat top-level `citations` array if one
appears — keep it defensive, the shape has shifted across xAI API versions. Each
citation's `source` (`x`/`web`) comes from the API or `inferSource(url)`;
`formatSources` renders the `## Sources` list with a `[X]`/`[web]` tag per entry.

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
text or a `{"type":"message","content":"..."}` envelope are both accepted.

The MCP transport (`run_agent`/`send_message`) only gives callers a single
`content` string, so `coerceMessage` also accepts a structured inputs object
passed *as* that string — `content: '{"query":"...","mode":"expert_opinions"}'`
(or a full `{"inputs":{...}}`). Without this, `mode`/`handles`/dates are
unreachable through MCP and every call silently defaults to `search_tweets`.
Plain (non-JSON) content is still treated as the `query`.

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
block, and that `## Sources` renders with `[X]`/`[web]` labels. Specifically
cover the citation logic: a numeric `title` is ignored in favor of an
`@handle`/hostname label, a bare URL written only in the body text is harvested
into `## Sources`, the opaque `x.com/i/status/<id>` and readable
`x.com/<handle>/status/<id>` forms of one post collapse to a single `@handle`
entry, and an opaque `x.com/i/user/<id>` profile link is dropped. Also confirm
the stdin path echoes `message_id` and exits cleanly on `{"type":"shutdown"}`.

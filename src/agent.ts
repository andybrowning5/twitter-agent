/**
 * Twitter (X) Research Agent — searches and reads public X via xAI Grok's
 * server-side Agent Tools (x_search, and web_search for cross-checking). Built
 * to be called by another program (often Claude Code doing research): every
 * answer is structured Markdown with an inline-cited, self-contained contract.
 *
 * Implementation notes:
 *   - No SDK dependency. Uses global fetch (Node 20+) to POST to the xAI
 *     Responses API. The Primordial security proxy injects the real key and
 *     forwards localhost -> api.x.ai, so we send to XAI_BASE_URL with the
 *     session token in XAI_API_KEY.
 *   - Server-side tools run inside Grok: it executes the search itself and
 *     returns one synthesized message with url_citation annotations. There is
 *     no client-side tool loop to run.
 *
 * Protocol: NDJSON over stdin/stdout.
 *   - First line on startup: {"type":"ready"}
 *   - Each message emits an {"type":"activity",...} event, then a final
 *     {"type":"response","content":"...","done":true} payload.
 *
 * Modes: search_tweets | search_accounts | trending | expert_opinions.
 */

import * as readline from "node:readline";

// --------------------------------------------------------------------------
// Types & protocol helpers
// --------------------------------------------------------------------------

type Mode = "search_tweets" | "search_accounts" | "trending" | "expert_opinions";

interface IncomingMessage {
  query: string;
  mode?: Mode;
  handles?: string;
  exclude_handles?: string;
  from_date?: string;
  to_date?: string;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function withId(obj: Record<string, unknown>, messageId?: string): Record<string, unknown> {
  return messageId ? { ...obj, message_id: messageId } : obj;
}

function activity(tool: string, description: string, messageId?: string): void {
  emit(withId({ type: "activity", tool, description }, messageId));
}

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const MODEL = "grok-4.3";
const VALID_MODES: Mode[] = ["search_tweets", "search_accounts", "trending", "expert_opinions"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HANDLES = 20;
const REQUEST_TIMEOUT_MS = 120_000;

// Modes that also get web_search alongside x_search, to cross-check claims
// against news/blogs/docs and verify who someone claims to be.
const WEB_SEARCH_MODES: Mode[] = ["expert_opinions", "trending"];

function apiBase(): string {
  // The proxy sets XAI_BASE_URL to a localhost URL. Fall back to the public
  // endpoint for local dry-runs outside the sandbox.
  return (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/+$/, "");
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// System prompts
// --------------------------------------------------------------------------

// Shared spine: the rules that keep every answer honest and machine-usable.
const GROUNDING =
  "You are the Twitter (X) Research Agent. A calling PROGRAM (often Claude Code " +
  "doing research) reads your output, so be information-dense, structured, and " +
  "self-contained.\n\n" +
  "GROUNDING RULES (non-negotiable):\n" +
  "- Ground every claim in real posts/results the tools return. Never invent " +
  "posts, handles, quotes, numbers, or links.\n" +
  "- Quotes must be VERBATIM. If you are not certain of the exact wording, " +
  "paraphrase plainly or omit it — never approximate inside quotation marks.\n" +
  "- For any field you cannot fill from evidence, write \"—\". Never guess.\n" +
  "- Author identity/credentials are model belief, not verified fact: write them " +
  "as \"model says: <claim> (unverified)\".\n" +
  "- Do NOT manufacture balance. Report the distribution you actually find; if " +
  "opinion is lopsided, say so. Don't invent a dissenting side to seem fair.\n" +
  "- Don't fabricate precise proportions. Use \"most\", \"several\", \"a few\" — " +
  "never invented percentages or vote counts.\n" +
  "- If signal is thin (few posts, low engagement, a single cluster), say so " +
  "plainly rather than overstating confidence.\n" +
  "- Present evidence; do NOT make the decision for the human or the caller.\n" +
  "- Order items most-relevant-first unless the mode says otherwise.\n" +
  "- For every post, account, quote, or statistic you cite, include its real " +
  "source URL inline from the search results — never invent one. A reference " +
  "is only captured as a source when its link is present, so favor citing items " +
  "you can link, and write the bare URL (e.g. https://x.com/<handle>/status/<id>) " +
  "next to the claim.\n" +
  "- Prefix every handle with @.";

// Shared output envelope.
const ENVELOPE =
  "STRUCTURE: Open with a \"## Summary\" (2-3 sentences — the headline answer). " +
  "Then the mode-specific sections below. Close with \"## Coverage\": how much " +
  "signal you found, the date window searched, and caveats. Do NOT write a " +
  "Sources section yourself — the calling program appends one from the " +
  "citations. Reference @handles inline so the prose stands on its own.";

const PER_MODE: Record<Mode, string> = {
  search_tweets:
    "MODE = SEARCH_TWEETS. Interpret the query SEMANTICALLY (by meaning, not " +
    "literal keywords) and surface the most relevant posts.\n" +
    "Output a \"## Findings\" section. For each notable post, a bullet with " +
    "these labeled fields (use \"—\" for any you can't fill):\n" +
    "- stance: supportive | critical | mixed | neutral (relative to the query's question)\n" +
    "- on: the specific point or subtopic the post addresses\n" +
    "- basis: firsthand experience | benchmark/data | opinion | secondhand | joke\n" +
    "- specifics: concrete details the post gives (versions, numbers, names)\n" +
    "- recency: how recent (use the post date when known)\n" +
    "- author: @handle — model says: who they are (unverified)\n" +
    "- quote: one VERBATIM line if you are sure of the wording, else omit\n" +
    "If the query is a DEBATE (X vs Y, is Z good/bad), group findings under " +
    "\"### Supportive\", \"### Critical\", and \"### Mixed\". If it is RELEASE or " +
    "BUG intel (e.g. \"problems with <release>\"), first decompose it into the " +
    "concrete failure modes people report and group findings under a " +
    "\"### <failure mode>\" header for each, noting impact and any workaround. " +
    "Aim for 5-12 posts unless the query is narrow.",

  search_accounts:
    "MODE = SEARCH_ACCOUNTS. The caller wants to discover ACCOUNTS, not " +
    "individual posts. Output an \"## Accounts\" section, one \"### @handle\" per " +
    "account with:\n" +
    "- who: model says: who they are (unverified)\n" +
    "- relevance: why they matter for THIS topic (original researcher, " +
    "breaking-news source, frequently cited, maintainer, etc.)\n" +
    "- profile: https://x.com/<handle>\n" +
    "- examples: up to 2 representative post links (omit if none found)\n" +
    "Rank by originality of contribution first, then how often others cite or " +
    "quote them, then recency of activity. List 5-15 accounts, most relevant first.",

  trending:
    "MODE = TRENDING / REAL-TIME. Summarize what is happening RIGHT NOW on X " +
    "about the topic. The \"## Summary\" must open with \"As of <time>:\" and an " +
    "overall status of ACTIVE, RESOLVED, or UNCLEAR.\n" +
    "Output a \"## Threads\" section. For each distinct thread or claim, a bullet " +
    "with (use \"—\" for any you can't fill):\n" +
    "- status: active | resolved | unclear. RESOLUTION BEATS AGE — a fixed issue " +
    "is resolved even if posts are recent; an official fix/clarification flips it.\n" +
    "- recency: the newest activity you see\n" +
    "- volume: rising | steady | fading | isolated\n" +
    "- driven_by: the @handles driving this thread\n" +
    "- official: any official/maintainer/company @handle response (else \"—\")\n" +
    "- claim: the core claim or development\n" +
    "- counter: notable pushback or correction (else \"—\")\n" +
    "- quote: one VERBATIM line if you are sure, else omit\n" +
    "In \"## Coverage\" include an \"as_of:\" timestamp. Prefer recent posts, and " +
    "use web_search to cross-check breaking claims against news/official sources.",

  expert_opinions:
    "MODE = EXPERT_OPINIONS. The caller is making a SYSTEM / ARCHITECTURE / " +
    "TECH-CHOICE decision and wants how credible practitioners actually lean. " +
    "Use BOTH x_search and web_search (engineering blogs, postmortems, docs) and " +
    "label where each point came from with [X] or [web].\n" +
    "Sections (in this order):\n" +
    "## Decision — restate the decision or tradeoff in one line.\n" +
    "## Where practitioners land — group under \"### <Option>\" headers. Per " +
    "option, bullets with: favors (the option), who (@handle/author — model " +
    "says ... (unverified)), basis (firsthand prod | benchmark | opinion), " +
    "specifics (scale, numbers, stack), quote (verbatim or omit), source ([X]/[web]).\n" +
    "## Tradeoff axes people actually raise — the real decision dimensions " +
    "(operational cost, scaling cliffs, hiring, lock-in, etc.), each with who raises it.\n" +
    "## Real-world prod reports — concrete \"we ran X at Y scale and Z happened\" " +
    "accounts, each with a [X]/[web] source label.\n" +
    "Surface the landscape; do NOT recommend a choice — let the human decide.",
};

function buildSystemPrompt(mode: Mode): string {
  return `${GROUNDING}\n\n${ENVELOPE}\n\n${PER_MODE[mode]}`;
}

// --------------------------------------------------------------------------
// Request building
// --------------------------------------------------------------------------

function parseHandles(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean)
    .slice(0, MAX_HANDLES);
  return list.length ? list : undefined;
}

// Builds the tools array. x_search is always present; web_search is added for
// the modes that benefit from cross-checking against the open web.
function buildTools(msg: IncomingMessage, mode: Mode): Record<string, unknown>[] {
  const x: Record<string, unknown> = {
    type: "x_search",
    enable_image_understanding: true,
    enable_video_understanding: true,
  };

  const allowed = parseHandles(msg.handles);
  const excluded = parseHandles(msg.exclude_handles);
  if (allowed) x.allowed_x_handles = allowed;
  if (excluded) x.excluded_x_handles = excluded;

  // Caller-supplied dates always win. Otherwise only trending gets an automatic
  // recency window (last 3 days); other modes stay open-ended on purpose so we
  // don't silently hide older, still-relevant discussion. We never auto-set
  // to_date — "up to now" is the right default.
  const from = msg.from_date && ISO_DATE.test(msg.from_date) ? msg.from_date : undefined;
  const to = msg.to_date && ISO_DATE.test(msg.to_date) ? msg.to_date : undefined;
  if (from) x.from_date = from;
  if (to) x.to_date = to;
  if (!from && !to && mode === "trending") x.from_date = isoDaysAgo(3);

  const tools: Record<string, unknown>[] = [x];
  if (WEB_SEARCH_MODES.includes(mode)) tools.push({ type: "web_search" });
  return tools;
}

// --------------------------------------------------------------------------
// Response parsing (xAI Responses API)
// --------------------------------------------------------------------------

interface Citation {
  url: string;
  title?: string;
  source: "x" | "web";
}

// Bare URLs in prose; terminates at whitespace or markdown/quote delimiters so
// trailing `)`, `]`, punctuation, etc. are trimmed off by the caller.
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/g;

function inferSource(url: string): "x" | "web" {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "x.com" || h === "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com")
      ? "x"
      : "web";
  } catch {
    return "web";
  }
}

function extractFromResponse(data: any): { text: string; citations: Citation[] } {
  let text = "";
  const citations: Citation[] = [];
  const seen = new Set<string>();

  const addCitation = (url: unknown, title?: unknown, source?: unknown) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    const src = source === "x" || source === "web" ? source : inferSource(url);
    citations.push({ url, title: typeof title === "string" ? title : undefined, source: src });
  };

  // Convenience aggregate some responses include.
  if (typeof data?.output_text === "string") text += data.output_text;

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block.text === "string") {
        if (!data?.output_text) text += block.text;
        const anns = Array.isArray(block.annotations) ? block.annotations : [];
        for (const a of anns) {
          if (a?.type === "url_citation") addCitation(a.url, a.title, a.source);
        }
      }
    }
  }

  // Some responses also surface a flat citations array.
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      if (typeof c === "string") addCitation(c);
      else if (c && typeof c === "object") addCitation(c.url, c.title, c.source);
    }
  }

  // Grok annotates only a handful of url_citations even when the body cites many
  // sources — and modes like search_accounts write profile/post links straight
  // into the prose that never become annotations. Harvest every real URL from
  // the text too; addCitation dedupes, so this only ADDS the links we'd miss.
  for (const url of text.match(URL_RE) || []) {
    addCitation(url.replace(/[)\].,;:'"]+$/, ""));
  }

  return { text: text.trim(), citations };
}

// xAI's url_citation `title` is just the visible citation NUMBER ("1", "2"),
// not a page title, so it makes a useless label. Derive a human label from the
// URL instead: @handle for X posts/profiles, hostname for the open web. Keep a
// real title only if the API ever provides a non-numeric one.
function citationLabel(c: Citation): string {
  const t = c.title?.trim();
  if (t && !/^\d+$/.test(t)) return t;
  try {
    const u = new URL(c.url);
    const host = u.hostname.replace(/^www\./, "");
    if (c.source === "x") {
      const handle = u.pathname.split("/").filter(Boolean)[0];
      if (handle && handle !== "i") return "@" + handle;
    }
    return host;
  } catch {
    return c.url;
  }
}

function formatSources(citations: Citation[]): string {
  if (!citations.length) return "";
  const lines = citations.map((c, i) => {
    const tag = c.source === "web" ? "[web]" : "[X]";
    return `${i + 1}. ${tag} ${citationLabel(c)} — ${c.url}`;
  });
  return `\n\n## Sources\n${lines.join("\n")}`;
}

// --------------------------------------------------------------------------
// Core handler
// --------------------------------------------------------------------------

async function handleMessage(msg: IncomingMessage, messageId?: string): Promise<void> {
  const query = (msg.query ?? "").trim();
  const mode: Mode = VALID_MODES.includes(msg.mode as Mode)
    ? (msg.mode as Mode)
    : "search_tweets";

  if (!query) {
    emit(withId({
      type: "response",
      content: "Error: no query provided. Pass a search task in the `query` field.",
      done: true,
      error: true,
    }, messageId));
    return;
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    emit(withId({
      type: "response",
      content:
        "Error: XAI_API_KEY is not set. This agent requires an xAI (Grok) key " +
        "to call the X Search API.",
      done: true,
      error: true,
    }, messageId));
    return;
  }

  const tools = buildTools(msg, mode);
  const toolNames = tools.map((t) => String(t.type)).join("+");
  const x = tools[0];
  const handleNote = x.allowed_x_handles
    ? ` handles=${(x.allowed_x_handles as string[]).join(",")}`
    : "";
  activity(toolNames, `mode=${mode}${handleNote} query=${query}`, messageId);

  const body = {
    model: MODEL,
    input: [{ role: "user", content: query }],
    instructions: buildSystemPrompt(mode),
    tools,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data: any;
  try {
    const res = await fetch(`${apiBase()}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      emit(withId({
        type: "response",
        content: `X Search request failed (HTTP ${res.status}): ${detail.slice(0, 600)}`,
        done: true,
        error: true,
      }, messageId));
      return;
    }
    data = await res.json();
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const detail = aborted
      ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    emit(withId({
      type: "response",
      content: `Twitter agent failed: ${detail}`,
      done: true,
      error: true,
    }, messageId));
    return;
  } finally {
    clearTimeout(timer);
  }

  const { text, citations } = extractFromResponse(data);
  if (!text) {
    emit(withId({
      type: "response",
      content:
        "No results. Grok returned no text for this query — try rephrasing, " +
        "widening the date range, or removing handle filters.",
      done: true,
    }, messageId));
    return;
  }

  emit(withId({ type: "response", content: text + formatSources(citations), done: true }, messageId));
}

// --------------------------------------------------------------------------
// Input parsing & main loop
// --------------------------------------------------------------------------

type ParsedLine =
  | { control: "shutdown" }
  | { control: "ignore" }
  | { msg: IncomingMessage; messageId?: string };

function coerceMessage(parsed: any): IncomingMessage {
  // Primordial's transport wraps a caller's string as {type:"message",
  // content:"..."}. That single string is often the ONLY channel a caller has
  // (e.g. Claude Code via the MCP run_agent/send_message tools), so accept a
  // structured inputs object passed AS that string — otherwise mode/handles
  // would be unreachable and every call would default to search_tweets.
  if (typeof parsed?.content === "string") {
    const inner = parsed.content.trim();
    if (inner.startsWith("{")) {
      try {
        const reparsed = JSON.parse(inner);
        if (reparsed && typeof reparsed === "object") return coerceMessage(reparsed);
      } catch {
        // not JSON — fall through and treat content as the query
      }
    }
  }
  const src = parsed.inputs && typeof parsed.inputs === "object" ? parsed.inputs : parsed;
  const query =
    typeof src.query === "string"
      ? src.query
      : typeof parsed.content === "string"
        ? parsed.content
        : "";
  return {
    query,
    mode: src.mode,
    handles: src.handles,
    exclude_handles: src.exclude_handles,
    from_date: src.from_date,
    to_date: src.to_date,
  };
}

function parseIncoming(raw: string): ParsedLine {
  const trimmed = raw.trim();
  if (!trimmed) return { control: "ignore" };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "shutdown") return { control: "shutdown" };
      if (parsed.type === "workspace_patch") return { control: "ignore" };
      return {
        msg: coerceMessage(parsed),
        messageId: typeof parsed.message_id === "string" ? parsed.message_id : undefined,
      };
    } catch {
      // fall through — treat as plain query text
    }
  }
  return { msg: { query: trimmed } };
}

async function main(): Promise<void> {
  emit({ type: "ready" });

  // One-shot CLI mode (Primordial dry-run path).
  const argPrompt = process.argv.slice(2).join(" ").trim();
  if (argPrompt) {
    const parsed = parseIncoming(argPrompt);
    if ("msg" in parsed) await handleMessage(parsed.msg, parsed.messageId);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const parsed = parseIncoming(line);
    if ("control" in parsed) {
      if (parsed.control === "shutdown") {
        rl.close();
        return;
      }
      continue;
    }
    await handleMessage(parsed.msg, parsed.messageId);
  }
}

main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  emit({ type: "response", content: `Fatal: ${detail}`, done: true, error: true });
  process.exit(1);
});

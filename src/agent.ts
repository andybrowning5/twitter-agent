/**
 * Twitter (X) Agent — searches and reads public X via xAI Grok's server-side
 * x_search tool (the Agent Tools API that replaced the retired Live Search
 * `search_parameters` API).
 *
 * Implementation notes:
 *   - No SDK dependency. Uses global fetch (Node 20+) to POST to the xAI
 *     Responses API. The Primordial security proxy injects the real key and
 *     forwards localhost -> api.x.ai, so we send to XAI_BASE_URL with the
 *     session token in XAI_API_KEY.
 *   - x_search runs server-side: Grok executes the search itself and returns
 *     one synthesized message with url_citation annotations. There is no
 *     client-side tool loop to run.
 *
 * Protocol: NDJSON over stdin/stdout.
 *   - First line on startup: {"type":"ready"}
 *   - Each message emits an {"type":"activity",...} event, then a final
 *     {"type":"response","content":"...","done":true} payload.
 */

import * as readline from "node:readline";

// --------------------------------------------------------------------------
// Types & protocol helpers
// --------------------------------------------------------------------------

type Mode = "search_tweets" | "search_accounts" | "trending";

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

function activity(tool: string, description: string): void {
  emit({ type: "activity", tool, description });
}

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const MODEL = "grok-4.3";
const VALID_MODES: Mode[] = ["search_tweets", "search_accounts", "trending"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HANDLES = 20;

function apiBase(): string {
  // The proxy sets XAI_BASE_URL to a localhost URL. Fall back to the public
  // endpoint for local dry-runs outside the sandbox.
  return (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/+$/, "");
}

// --------------------------------------------------------------------------
// System prompts per mode
// --------------------------------------------------------------------------

function buildSystemPrompt(mode: Mode): string {
  const base =
    "You are the Twitter (X) Agent. You search PUBLIC X (Twitter) using the " +
    "x_search tool and report back to a calling program. Always ground your " +
    "answer in actual posts you found via x_search — never invent posts, " +
    "handles, or quotes. If x_search returns nothing relevant, say so plainly. " +
    "Quote handles with a leading @. Be concise and information-dense; the " +
    "caller wants signal, not commentary.";

  const perMode: Record<Mode, string> = {
    search_tweets:
      "MODE = SEARCH_TWEETS. Interpret the query semantically (by meaning, " +
      "not just literal keywords) and surface the most relevant posts. For " +
      "each notable post, give: the @handle, a one-line paraphrase or short " +
      "quote, and what makes it relevant. Group by theme/stance when the " +
      "query is a debate. Aim for 5-12 posts unless the query is narrow.",
    search_accounts:
      "MODE = SEARCH_ACCOUNTS. The caller wants to discover ACCOUNTS, not " +
      "individual posts. Identify the most relevant @handles for the topic. " +
      "For each, give: the @handle, a one-line description of who they are / " +
      "what they post about, and why they matter for this topic (e.g. " +
      "frequently cited, original researcher, breaking-news source). List " +
      "5-15 accounts, most relevant first.",
    trending:
      "MODE = TRENDING. Summarize what is being discussed RIGHT NOW on X " +
      "about this topic: the dominant narratives, notable new claims, who is " +
      "driving the conversation, and any emerging consensus or split. Lead " +
      "with a 2-3 sentence summary, then bullet the key threads with the " +
      "@handles driving each. Prefer recent posts.",
  };

  const format =
    "After your answer, the calling program will append a Sources section " +
    "automatically from the citations — you do NOT need to write a Sources " +
    "list yourself, but DO reference handles inline so the answer is " +
    "self-contained.";

  return `${base}\n\n${perMode[mode]}\n\n${format}`;
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

function buildXSearchTool(msg: IncomingMessage): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "x_search",
    enable_image_understanding: true,
  };
  const allowed = parseHandles(msg.handles);
  const excluded = parseHandles(msg.exclude_handles);
  if (allowed) tool.allowed_x_handles = allowed;
  if (excluded) tool.excluded_x_handles = excluded;
  if (msg.from_date && ISO_DATE.test(msg.from_date)) tool.from_date = msg.from_date;
  if (msg.to_date && ISO_DATE.test(msg.to_date)) tool.to_date = msg.to_date;
  return tool;
}

// --------------------------------------------------------------------------
// Response parsing (xAI Responses API)
// --------------------------------------------------------------------------

interface Citation {
  url: string;
  title?: string;
}

function extractFromResponse(data: any): { text: string; citations: Citation[] } {
  let text = "";
  const citations: Citation[] = [];
  const seen = new Set<string>();

  const addCitation = (url: unknown, title?: unknown) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    citations.push({ url, title: typeof title === "string" ? title : undefined });
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
          if (a?.type === "url_citation") addCitation(a.url, a.title);
        }
      }
    }
  }

  // Some responses also surface a flat citations array of URLs.
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      if (typeof c === "string") addCitation(c);
      else if (c && typeof c === "object") addCitation(c.url, c.title);
    }
  }

  return { text: text.trim(), citations };
}

function formatSources(citations: Citation[]): string {
  if (!citations.length) return "";
  const lines = citations.map((c, i) => {
    const label = c.title && c.title.trim() ? c.title.trim() : c.url;
    return `${i + 1}. ${label} — ${c.url}`;
  });
  return `\n\nSources:\n${lines.join("\n")}`;
}

// --------------------------------------------------------------------------
// Core handler
// --------------------------------------------------------------------------

async function handleMessage(msg: IncomingMessage): Promise<void> {
  const query = (msg.query ?? "").trim();
  const mode: Mode = VALID_MODES.includes(msg.mode as Mode)
    ? (msg.mode as Mode)
    : "search_tweets";

  if (!query) {
    emit({
      type: "response",
      content: "Error: no query provided. Pass a search task in the `query` field.",
      done: true,
      error: true,
    });
    return;
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    emit({
      type: "response",
      content:
        "Error: XAI_API_KEY is not set. This agent requires an xAI (Grok) key " +
        "to call the X Search API.",
      done: true,
      error: true,
    });
    return;
  }

  const tool = buildXSearchTool(msg);
  const handleNote = tool.allowed_x_handles
    ? ` handles=${(tool.allowed_x_handles as string[]).join(",")}`
    : "";
  activity("x_search", `mode=${mode}${handleNote} query=${query}`);

  const body = {
    model: MODEL,
    input: [{ role: "user", content: query }],
    instructions: buildSystemPrompt(mode),
    tools: [tool],
  };

  let data: any;
  try {
    const res = await fetch(`${apiBase()}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      emit({
        type: "response",
        content: `X Search request failed (HTTP ${res.status}): ${detail.slice(0, 600)}`,
        done: true,
        error: true,
      });
      return;
    }
    data = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    emit({
      type: "response",
      content: `Twitter agent failed: ${detail}`,
      done: true,
      error: true,
    });
    return;
  }

  const { text, citations } = extractFromResponse(data);
  if (!text) {
    emit({
      type: "response",
      content:
        "No results. Grok returned no text for this query — try rephrasing, " +
        "widening the date range, or removing handle filters.",
      done: true,
    });
    return;
  }

  emit({ type: "response", content: text + formatSources(citations), done: true });
}

// --------------------------------------------------------------------------
// Input parsing & main loop
// --------------------------------------------------------------------------

function coerceMessage(parsed: any): IncomingMessage {
  const src = parsed.inputs && typeof parsed.inputs === "object" ? parsed.inputs : parsed;
  const query =
    typeof src.query === "string"
      ? src.query
      : parsed.type === "message" && typeof parsed.content === "string"
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

function parseIncoming(raw: string): IncomingMessage {
  const trimmed = raw.trim();
  if (!trimmed) return { query: "" };
  if (trimmed.startsWith("{")) {
    try {
      return coerceMessage(JSON.parse(trimmed));
    } catch {
      // fall through — treat as plain query text
    }
  }
  return { query: trimmed };
}

async function main(): Promise<void> {
  emit({ type: "ready" });

  // One-shot CLI mode (Primordial dry-run path).
  const argPrompt = process.argv.slice(2).join(" ").trim();
  if (argPrompt) {
    await handleMessage(parseIncoming(argPrompt));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    await handleMessage(parseIncoming(line));
  }
}

main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  emit({ type: "response", content: `Fatal: ${detail}`, done: true, error: true });
  process.exit(1);
});

import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/agent.ts
import * as readline from "node:readline";
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function withId(obj, messageId) {
  return messageId ? { ...obj, message_id: messageId } : obj;
}
function activity(tool, description, messageId) {
  emit(withId({ type: "activity", tool, description }, messageId));
}
var MODEL = "grok-4.3";
var VALID_MODES = ["search_tweets", "search_accounts", "trending", "expert_opinions"];
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
var MAX_HANDLES = 20;
var REQUEST_TIMEOUT_MS = 12e4;
var WEB_SEARCH_MODES = ["expert_opinions", "trending"];
function apiBase() {
  return (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/+$/, "");
}
function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}
var GROUNDING = `You are the Twitter (X) Research Agent. A calling PROGRAM (often Claude Code doing research) reads your output, so be information-dense, structured, and self-contained.

GROUNDING RULES (non-negotiable):
- Ground every claim in real posts/results the tools return. Never invent posts, handles, quotes, numbers, or links.
- Quotes must be VERBATIM. If you are not certain of the exact wording, paraphrase plainly or omit it \u2014 never approximate inside quotation marks.
- For any field you cannot fill from evidence, write "\u2014". Never guess.
- Author identity/credentials are model belief, not verified fact: write them as "model says: <claim> (unverified)".
- Do NOT manufacture balance. Report the distribution you actually find; if opinion is lopsided, say so. Don't invent a dissenting side to seem fair.
- Don't fabricate precise proportions. Use "most", "several", "a few" \u2014 never invented percentages or vote counts.
- If signal is thin (few posts, low engagement, a single cluster), say so plainly rather than overstating confidence.
- Present evidence; do NOT make the decision for the human or the caller.
- Order items most-relevant-first unless the mode says otherwise.
- For every post, account, quote, or statistic you cite, include its real source URL inline from the search results \u2014 never invent one. A reference is only captured as a source when its link is present, so favor citing items you can link, and write the bare URL (e.g. https://x.com/<handle>/status/<id>) next to the claim.
- Prefix every handle with @.`;
var ENVELOPE = 'STRUCTURE: Open with a "## Summary" (2-3 sentences \u2014 the headline answer). Then the mode-specific sections below. Close with "## Coverage": how much signal you found, the date window searched, and caveats. Do NOT write a Sources section yourself \u2014 the calling program appends one from the citations. Reference @handles inline so the prose stands on its own.';
var PER_MODE = {
  search_tweets: `MODE = SEARCH_TWEETS. Interpret the query SEMANTICALLY (by meaning, not literal keywords) and surface the most relevant posts.
Output a "## Findings" section. For each notable post, a bullet with these labeled fields (use "\u2014" for any you can't fill):
- stance: supportive | critical | mixed | neutral (relative to the query's question)
- on: the specific point or subtopic the post addresses
- basis: firsthand experience | benchmark/data | opinion | secondhand | joke
- specifics: concrete details the post gives (versions, numbers, names)
- recency: how recent (use the post date when known)
- author: @handle \u2014 model says: who they are (unverified)
- quote: one VERBATIM line if you are sure of the wording, else omit
If the query is a DEBATE (X vs Y, is Z good/bad), group findings under "### Supportive", "### Critical", and "### Mixed". If it is RELEASE or BUG intel (e.g. "problems with <release>"), first decompose it into the concrete failure modes people report and group findings under a "### <failure mode>" header for each, noting impact and any workaround. Aim for 5-12 posts unless the query is narrow.`,
  search_accounts: 'MODE = SEARCH_ACCOUNTS. The caller wants to discover ACCOUNTS, not individual posts. Output an "## Accounts" section, one "### @handle" per account with:\n- who: model says: who they are (unverified)\n- relevance: why they matter for THIS topic (original researcher, breaking-news source, frequently cited, maintainer, etc.)\n- profile: https://x.com/<handle>\n- examples: up to 2 representative post links (omit if none found)\nRank by originality of contribution first, then how often others cite or quote them, then recency of activity. List 5-15 accounts, most relevant first.',
  trending: `MODE = TRENDING / REAL-TIME. Summarize what is happening RIGHT NOW on X about the topic. The "## Summary" must open with "As of <time>:" and an overall status of ACTIVE, RESOLVED, or UNCLEAR.
Output a "## Threads" section. For each distinct thread or claim, a bullet with (use "\u2014" for any you can't fill):
- status: active | resolved | unclear. RESOLUTION BEATS AGE \u2014 a fixed issue is resolved even if posts are recent; an official fix/clarification flips it.
- recency: the newest activity you see
- volume: rising | steady | fading | isolated
- driven_by: the @handles driving this thread
- official: any official/maintainer/company @handle response (else "\u2014")
- claim: the core claim or development
- counter: notable pushback or correction (else "\u2014")
- quote: one VERBATIM line if you are sure, else omit
In "## Coverage" include an "as_of:" timestamp. Prefer recent posts, and use web_search to cross-check breaking claims against news/official sources.`,
  expert_opinions: 'MODE = EXPERT_OPINIONS. The caller is making a SYSTEM / ARCHITECTURE / TECH-CHOICE decision and wants how credible practitioners actually lean. Use BOTH x_search and web_search (engineering blogs, postmortems, docs) and label where each point came from with [X] or [web].\nSections (in this order):\n## Decision \u2014 restate the decision or tradeoff in one line.\n## Where practitioners land \u2014 group under "### <Option>" headers. Per option, bullets with: favors (the option), who (@handle/author \u2014 model says ... (unverified)), basis (firsthand prod | benchmark | opinion), specifics (scale, numbers, stack), quote (verbatim or omit), source ([X]/[web]).\n## Tradeoff axes people actually raise \u2014 the real decision dimensions (operational cost, scaling cliffs, hiring, lock-in, etc.), each with who raises it.\n## Real-world prod reports \u2014 concrete "we ran X at Y scale and Z happened" accounts, each with a [X]/[web] source label.\nSurface the landscape; do NOT recommend a choice \u2014 let the human decide.'
};
function buildSystemPrompt(mode) {
  return `${GROUNDING}

${ENVELOPE}

${PER_MODE[mode]}`;
}
function parseHandles(raw) {
  if (!raw) return void 0;
  const list = raw.split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean).slice(0, MAX_HANDLES);
  return list.length ? list : void 0;
}
function buildTools(msg, mode) {
  const x = {
    type: "x_search",
    enable_image_understanding: true,
    enable_video_understanding: true
  };
  const allowed = parseHandles(msg.handles);
  const excluded = parseHandles(msg.exclude_handles);
  if (allowed) x.allowed_x_handles = allowed;
  if (excluded) x.excluded_x_handles = excluded;
  const from = msg.from_date && ISO_DATE.test(msg.from_date) ? msg.from_date : void 0;
  const to = msg.to_date && ISO_DATE.test(msg.to_date) ? msg.to_date : void 0;
  if (from) x.from_date = from;
  if (to) x.to_date = to;
  if (!from && !to && mode === "trending") x.from_date = isoDaysAgo(3);
  const tools = [x];
  if (WEB_SEARCH_MODES.includes(mode)) tools.push({ type: "web_search" });
  return tools;
}
var URL_RE = /https?:\/\/[^\s<>()\[\]"']+/g;
function inferSource(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "x.com" || h === "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com") ? "x" : "web";
  } catch {
    return "web";
  }
}
function extractFromResponse(data) {
  let text = "";
  const citations = [];
  const seen = /* @__PURE__ */ new Set();
  const addCitation = (url, title, source) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    const src = source === "x" || source === "web" ? source : inferSource(url);
    citations.push({ url, title: typeof title === "string" ? title : void 0, source: src });
  };
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
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      if (typeof c === "string") addCitation(c);
      else if (c && typeof c === "object") addCitation(c.url, c.title, c.source);
    }
  }
  for (const url of text.match(URL_RE) || []) {
    addCitation(url.replace(/[)\].,;:'"]+$/, ""));
  }
  return { text: text.trim(), citations };
}
function citationLabel(c) {
  const t = c.title?.trim();
  if (t && !/^\d+$/.test(t) && !t.includes("://")) return t;
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
function formatSources(citations) {
  if (!citations.length) return "";
  const lines = citations.map((c, i) => {
    const tag = c.source === "web" ? "[web]" : "[X]";
    return `${i + 1}. ${tag} ${citationLabel(c)} \u2014 ${c.url}`;
  });
  return `

## Sources
${lines.join("\n")}`;
}
async function handleMessage(msg, messageId) {
  const query = (msg.query ?? "").trim();
  const mode = VALID_MODES.includes(msg.mode) ? msg.mode : "search_tweets";
  if (!query) {
    emit(withId({
      type: "response",
      content: "Error: no query provided. Pass a search task in the `query` field.",
      done: true,
      error: true
    }, messageId));
    return;
  }
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    emit(withId({
      type: "response",
      content: "Error: XAI_API_KEY is not set. This agent requires an xAI (Grok) key to call the X Search API.",
      done: true,
      error: true
    }, messageId));
    return;
  }
  const tools = buildTools(msg, mode);
  const toolNames = tools.map((t) => String(t.type)).join("+");
  const x = tools[0];
  const handleNote = x.allowed_x_handles ? ` handles=${x.allowed_x_handles.join(",")}` : "";
  activity(toolNames, `mode=${mode}${handleNote} query=${query}`, messageId);
  const body = {
    model: MODEL,
    input: [{ role: "user", content: query }],
    instructions: buildSystemPrompt(mode),
    tools
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(`${apiBase()}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      emit(withId({
        type: "response",
        content: `X Search request failed (HTTP ${res.status}): ${detail.slice(0, 600)}`,
        done: true,
        error: true
      }, messageId));
      return;
    }
    data = await res.json();
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const detail = aborted ? `request timed out after ${REQUEST_TIMEOUT_MS / 1e3}s` : err instanceof Error ? err.message : String(err);
    emit(withId({
      type: "response",
      content: `Twitter agent failed: ${detail}`,
      done: true,
      error: true
    }, messageId));
    return;
  } finally {
    clearTimeout(timer);
  }
  const { text, citations } = extractFromResponse(data);
  if (!text) {
    emit(withId({
      type: "response",
      content: "No results. Grok returned no text for this query \u2014 try rephrasing, widening the date range, or removing handle filters.",
      done: true
    }, messageId));
    return;
  }
  emit(withId({ type: "response", content: text + formatSources(citations), done: true }, messageId));
}
function coerceMessage(parsed) {
  if (typeof parsed?.content === "string") {
    const inner = parsed.content.trim();
    if (inner.startsWith("{")) {
      try {
        const reparsed = JSON.parse(inner);
        if (reparsed && typeof reparsed === "object") return coerceMessage(reparsed);
      } catch {
      }
    }
  }
  const src = parsed.inputs && typeof parsed.inputs === "object" ? parsed.inputs : parsed;
  const query = typeof src.query === "string" ? src.query : typeof parsed.content === "string" ? parsed.content : "";
  return {
    query,
    mode: src.mode,
    handles: src.handles,
    exclude_handles: src.exclude_handles,
    from_date: src.from_date,
    to_date: src.to_date
  };
}
function parseIncoming(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { control: "ignore" };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "shutdown") return { control: "shutdown" };
      if (parsed.type === "workspace_patch") return { control: "ignore" };
      return {
        msg: coerceMessage(parsed),
        messageId: typeof parsed.message_id === "string" ? parsed.message_id : void 0
      };
    } catch {
    }
  }
  return { msg: { query: trimmed } };
}
async function main() {
  emit({ type: "ready" });
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

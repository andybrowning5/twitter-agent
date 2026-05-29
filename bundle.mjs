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
var VALID_MODES = ["search_tweets", "search_accounts", "trending"];
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
var MAX_HANDLES = 20;
function apiBase() {
  return (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/+$/, "");
}
function buildSystemPrompt(mode) {
  const base = "You are the Twitter (X) Agent. You search PUBLIC X (Twitter) using the x_search tool and report back to a calling program. Always ground your answer in actual posts you found via x_search \u2014 never invent posts, handles, or quotes. If x_search returns nothing relevant, say so plainly. Quote handles with a leading @. Be concise and information-dense; the caller wants signal, not commentary.";
  const perMode = {
    search_tweets: "MODE = SEARCH_TWEETS. Interpret the query semantically (by meaning, not just literal keywords) and surface the most relevant posts. For each notable post, give: the @handle, a one-line paraphrase or short quote, and what makes it relevant. Group by theme/stance when the query is a debate. Aim for 5-12 posts unless the query is narrow.",
    search_accounts: "MODE = SEARCH_ACCOUNTS. The caller wants to discover ACCOUNTS, not individual posts. Identify the most relevant @handles for the topic. For each, give: the @handle, a one-line description of who they are / what they post about, and why they matter for this topic (e.g. frequently cited, original researcher, breaking-news source). List 5-15 accounts, most relevant first.",
    trending: "MODE = TRENDING. Summarize what is being discussed RIGHT NOW on X about this topic: the dominant narratives, notable new claims, who is driving the conversation, and any emerging consensus or split. Lead with a 2-3 sentence summary, then bullet the key threads with the @handles driving each. Prefer recent posts."
  };
  const format = "After your answer, the calling program will append a Sources section automatically from the citations \u2014 you do NOT need to write a Sources list yourself, but DO reference handles inline so the answer is self-contained.";
  return `${base}

${perMode[mode]}

${format}`;
}
function parseHandles(raw) {
  if (!raw) return void 0;
  const list = raw.split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean).slice(0, MAX_HANDLES);
  return list.length ? list : void 0;
}
function buildXSearchTool(msg) {
  const tool = {
    type: "x_search",
    enable_image_understanding: true
  };
  const allowed = parseHandles(msg.handles);
  const excluded = parseHandles(msg.exclude_handles);
  if (allowed) tool.allowed_x_handles = allowed;
  if (excluded) tool.excluded_x_handles = excluded;
  if (msg.from_date && ISO_DATE.test(msg.from_date)) tool.from_date = msg.from_date;
  if (msg.to_date && ISO_DATE.test(msg.to_date)) tool.to_date = msg.to_date;
  return tool;
}
function extractFromResponse(data) {
  let text = "";
  const citations = [];
  const seen = /* @__PURE__ */ new Set();
  const addCitation = (url, title) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    citations.push({ url, title: typeof title === "string" ? title : void 0 });
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
          if (a?.type === "url_citation") addCitation(a.url, a.title);
        }
      }
    }
  }
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      if (typeof c === "string") addCitation(c);
      else if (c && typeof c === "object") addCitation(c.url, c.title);
    }
  }
  return { text: text.trim(), citations };
}
function formatSources(citations) {
  if (!citations.length) return "";
  const lines = citations.map((c, i) => {
    const label = c.title && c.title.trim() ? c.title.trim() : c.url;
    return `${i + 1}. ${label} \u2014 ${c.url}`;
  });
  return `

Sources:
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
  const tool = buildXSearchTool(msg);
  const handleNote = tool.allowed_x_handles ? ` handles=${tool.allowed_x_handles.join(",")}` : "";
  activity("x_search", `mode=${mode}${handleNote} query=${query}`, messageId);
  const body = {
    model: MODEL,
    input: [{ role: "user", content: query }],
    instructions: buildSystemPrompt(mode),
    tools: [tool]
  };
  let data;
  try {
    const res = await fetch(`${apiBase()}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
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
    const detail = err instanceof Error ? err.message : String(err);
    emit(withId({
      type: "response",
      content: `Twitter agent failed: ${detail}`,
      done: true,
      error: true
    }, messageId));
    return;
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

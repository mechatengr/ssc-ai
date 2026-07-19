// src/duckduckgo.js
// Free, keyless supplement to Gemini's native Google Search grounding.
//
// DuckDuckGo's Instant Answer API (api.duckduckgo.com) requires no API key
// and has no rate limit for reasonable personal use, but it only returns
// "instant answer" style content (topic summaries, definitions, disambig
// links) — not full web search results. We use it as a *hybrid* supplement:
// when Web Search is on, we fire this alongside Gemini's own grounding tool
// call and fold in whatever DuckDuckGo has, clearly labeled as its own
// source so it's never confused with Gemini's grounding citations.

const DDG_TIMEOUT_MS = 4000;
const MAX_RELATED_TOPICS = 3;

function cleanQueryForDDG(rawMessage) {
  if (!rawMessage) return "";
  return rawMessage
    .replace(/\[FILE:[\s\S]*?\[\/FILE\]/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Queries DuckDuckGo's Instant Answer API. Best-effort only: any failure
 * (network, timeout, malformed response, or simply "no instant answer for
 * this query" — which is common) resolves to an empty result rather than
 * throwing, so it never blocks or breaks the main chat flow.
 * Returns { snippet: string|null, sources: {title, uri}[] }.
 */
async function duckDuckGoInstantAnswer(rawMessage) {
  const query = cleanQueryForDDG(rawMessage);
  if (!query) return { snippet: null, sources: [] };

  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { snippet: null, sources: [] };

    const data = await res.json();
    const sources = [];
    let snippet = null;

    if (data.AbstractText) {
      snippet = data.AbstractText;
      if (data.AbstractURL) sources.push({ title: data.Heading || "DuckDuckGo", uri: data.AbstractURL });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (sources.length >= MAX_RELATED_TOPICS) break;
        // Add type validation to prevent crashes on malformed data
        if (topic?.FirstURL && topic?.Text && typeof topic.Text === 'string') {
          sources.push({ title: topic.Text.split(" - ")[0].slice(0, 80), uri: topic.FirstURL });
        }
      }
    }

    return { snippet, sources };
  } catch (_) {
    clearTimeout(timeout);
    return { snippet: null, sources: [] }; // best-effort — never blocks the main chat flow
  }
}

function formatDDGSnippetForPrompt(snippet) {
  if (!snippet) return "";
  return `\n\n[DUCKDUCKGO INSTANT ANSWER — supplementary context, verify against your own knowledge]\n${snippet}`;
}

module.exports = { duckDuckGoInstantAnswer, formatDDGSnippetForPrompt, cleanQueryForDDG };

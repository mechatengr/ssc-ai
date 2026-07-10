// src/index.js
// SSC AI Backend - Entry point.
// Modern, fast Node.js + Express backend using Server-Sent Events (SSE) for
// real-time token streaming from Google Gemini, with multi-key rotation,
// model fallback, live-time injection, web search grounding, and a
// two-pass "Mastermind" reasoning mode.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { KeyManager } = require("./keyManager");
const { streamChat, AllProvidersExhaustedError } = require("./gemini");
const { buildSystemPrompt, getLiveClockBlock } = require("./systemPrompt");

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MODEL_CHAIN = (process.env.GEMINI_MODELS ||
  "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-1.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let keyManager;
try {
  keyManager = new KeyManager((process.env.GEMINI_API_KEYS || "").split(","));
} catch (err) {
  console.error("\n✗ SSC AI Backend failed to start: " + err.message);
  console.error("  Set GEMINI_API_KEYS in your environment (see backend/.env.example).\n");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "12mb" })); // generous limit for pasted file text

// ---- CORS -------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((o) => o.trim());
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        allowedOrigins.includes("*") ||
        !origin ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Origin not allowed by CORS whitelist"));
      }
    },
  })
);

// ---- Rate limiting (basic abuse protection, generous for personal use) --
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---- Health / status ----------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SSC AI Backend",
    time: getLiveClockBlock(),
    models: MODEL_CHAIN,
    keys: keyManager.status(),
  });
});

// ---- Main streaming chat endpoint (SSE) ----------------------------------
app.post("/api/chat", async (req, res) => {
  const {
    messages = [],
    persona = "researcher",
    customPersonaPrompt = "",
    systemPromptOverride = "",
    language = "en",
    deepThink = false,
    mastermind = false,
    webSearchEnabled = false,
    temperature = 0.7,
    maxTokens = 2048,
    model, // optional explicit model choice; falls back to chain if omitted/unavailable
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // If the client disconnects mid-stream (e.g. hits Stop), writes to the
  // closed socket must not crash the process.
  res.on("error", () => { /* client gone; nothing more to do */ });

  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      /* socket already closed; ignore */
    }
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  // Explicit model first (if given), then the rest of the configured chain.
  const modelChain = model
    ? [model, ...MODEL_CHAIN.filter((m) => m !== model)]
    : MODEL_CHAIN;

  try {
    let systemPrompt = buildSystemPrompt({
      persona,
      customPersonaPrompt,
      systemPromptOverride,
      language,
      deepThink,
      mastermind,
      webSearchEnabled,
    });

    // ---- Mastermind: silent first pass produces condensed reasoning,
    // which is then folded into the system prompt for the real, streamed
    // second pass. The first pass is NOT shown to the user directly.
    if (mastermind) {
      send("status", { stage: "mastermind-pass-1" });
      try {
        const pass1 = await streamChat({
          keyManager,
          modelChain,
          systemPrompt:
            systemPrompt +
            "\n\nThis is PASS 1 of 2 (internal). Produce only a condensed, bullet-point analysis of the problem: key facts, approach, and potential pitfalls. Do not answer the user yet. Max 150 words.",
          messages,
          temperature: Math.min(temperature, 0.6),
          maxOutputTokens: 400,
          signal: abortController.signal,
          timeoutMs: TIMEOUT_MS,
        });
        systemPrompt += `\n\n[INTERNAL PASS-1 ANALYSIS - use this to inform your final answer, do not repeat it verbatim]\n${pass1.fullText}`;
      } catch (e) {
        // If pass 1 fails, just proceed straight to the normal single pass.
      }
      send("status", { stage: "mastermind-pass-2" });
    }

    const { modelUsed, keySuffixUsed, sources } = await streamChat({
      keyManager,
      modelChain,
      systemPrompt,
      messages,
      temperature,
      maxOutputTokens: maxTokens,
      groundingEnabled: webSearchEnabled,
      signal: abortController.signal,
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => send("chunk", { text }),
      onRetry: () => send("reset", { reason: "Switching to a fallback model/key — restarting response." }),
    });

    if (sources && sources.length) send("sources", { sources });
    send("done", { modelUsed, keySuffixUsed });
    safeEnd();
  } catch (err) {
    if (err.name === "AbortError") {
      send("aborted", { message: "Generation stopped." });
      return safeEnd();
    }
    if (err instanceof AllProvidersExhaustedError) {
      send("error", {
        type: "quota",
        message:
          "All configured Gemini keys/models are temporarily rate-limited. Please try again shortly.",
        attempts: err.attempts,
      });
      return safeEnd();
    }
    send("error", { type: "unknown", message: err.message });
    safeEnd();
  }
});

// ---- Non-streaming helper endpoints (summaries, titles) -----------------
async function nonStreamingComplete({ systemPrompt, userText, maxTokens = 200 }) {
  let full = "";
  await streamChat({
    keyManager,
    modelChain: MODEL_CHAIN,
    systemPrompt,
    messages: [{ role: "user", content: userText }],
    temperature: 0.4,
    maxOutputTokens: maxTokens,
    timeoutMs: TIMEOUT_MS,
    onChunk: (t) => (full += t),
  });
  return full.trim();
}

app.post("/api/summarize", async (req, res) => {
  try {
    const { conversationText } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const summary = await nonStreamingComplete({
      systemPrompt:
        "You are SSC AI. Summarize the following conversation in 3-5 concise bullet points, capturing key questions and conclusions. Output only the bullets.",
      userText: conversationText.slice(0, 20000),
      maxTokens: 300,
    });
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/title", async (req, res) => {
  try {
    const { conversationText } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const title = await nonStreamingComplete({
      systemPrompt:
        "Generate a short, specific chat title (max 6 words, no quotes, no punctuation at the end) summarizing this conversation's topic. Output ONLY the title text.",
      userText: conversationText.slice(0, 4000),
      maxTokens: 20,
    });
    res.json({ title: title.replace(/^["']|["']$/g, "") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/suggestions", async (req, res) => {
  try {
    const { conversationText } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const raw = await nonStreamingComplete({
      systemPrompt:
        'Based on this conversation, suggest exactly 3 short natural follow-up questions the user might ask next. Output ONLY a JSON array of 3 strings, nothing else, e.g. ["...","...","..."]',
      userText: conversationText.slice(0, 6000),
      maxTokens: 150,
    });
    let suggestions = [];
    try {
      suggestions = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    } catch (_) {
      suggestions = [];
    }
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Global error handler (e.g. malformed JSON body, oversized payload) --
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Unexpected server error" });
});

app.listen(PORT, () => {
  console.log(`SSC AI Backend running on port ${PORT}`);
  console.log(`Model chain: ${MODEL_CHAIN.join(" -> ")}`);
  console.log(`Keys loaded: ${keyManager.size()}`);
});

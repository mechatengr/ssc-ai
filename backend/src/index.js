// src/index.js
// SSC AI Backend - Entry point.
// Supports Gemini and Groq providers.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { KeyManager } = require("./keyManager");
const { streamChat: geminiStream, AllProvidersExhaustedError: GeminiError } = require("./gemini");
const { streamChat: groqStream, AllProvidersExhaustedError: GroqError } = require("./groq");
const { buildSystemPrompt, getLiveClockBlock } = require("./systemPrompt");
const { duckDuckGoInstantAnswer, formatDDGSnippetForPrompt } = require("./duckduckgo");

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

// ---- Gemini config ----
const GEMINI_MODELS = (process.env.GEMINI_MODELS ||
  "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-1.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let geminiKeyManager;
try {
  geminiKeyManager = new KeyManager((process.env.GEMINI_API_KEYS || "").split(","));
} catch (err) {
  console.error("\n✗ Gemini keys missing: " + err.message);
  process.exit(1);
}

// ---- Groq config ----
const GROQ_MODELS = (process.env.GROQ_MODELS ||
  "llama-3.1-70b-versatile,llama-3.1-8b-instant,mixtral-8x7b-32768,gemma2-9b-it")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let groqKeyManager = null;
try {
  groqKeyManager = new KeyManager((process.env.GROQ_API_KEYS || "").split(","));
} catch (err) {
  console.warn("⚠ Groq keys not configured; Groq models will be unavailable.");
}

const app = express();
app.use(express.json({ limit: "12mb" }));

// ---- CORS ----
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

// ---- Rate limiting ----
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SSC AI Backend",
    time: getLiveClockBlock(),
    providers: {
      gemini: {
        models: GEMINI_MODELS,
        keys: geminiKeyManager.status(),
      },
      groq: groqKeyManager
        ? { models: GROQ_MODELS, keys: groqKeyManager.status() }
        : { available: false },
    },
  });
});

// ---- Main streaming endpoint ----
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
    model,
    provider: requestedProvider, // optional "gemini" or "groq"
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] is required" });
  }

  // Determine provider
  let provider = requestedProvider;
  if (!provider) {
    if (model && model.startsWith("groq-")) provider = "groq";
    else provider = "gemini";
  }
  // If provider is "groq" but no groqKeyManager, fallback to gemini
  if (provider === "groq" && !groqKeyManager) {
    console.warn("Groq requested but not configured – falling back to Gemini");
    provider = "gemini";
  }

  // Select the appropriate model chain and key manager
  let modelChain;
  let keyManager;
  let streamFunc;
  let isGemini = false;

  if (provider === "groq") {
    modelChain = model
      ? [model, ...GROQ_MODELS.filter((m) => m !== model)]
      : GROQ_MODELS;
    keyManager = groqKeyManager;
    streamFunc = groqStream;
  } else {
    // Gemini
    modelChain = model
      ? [model, ...GEMINI_MODELS.filter((m) => m !== model)]
      : GEMINI_MODELS;
    keyManager = geminiKeyManager;
    streamFunc = geminiStream;
    isGemini = true;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.on("error", () => {});

  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

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

    // Mastermind only supported for Gemini (simplified)
    if (mastermind && isGemini) {
      send("status", { stage: "mastermind-pass-1" });
      try {
        const pass1 = await geminiStream({
          keyManager: geminiKeyManager,
          modelChain: GEMINI_MODELS,
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
      } catch (e) {}
      send("status", { stage: "mastermind-pass-2" });
    }

    if (webSearchEnabled) send("status", { stage: "grounding" });

    // DuckDuckGo only for Gemini (and only if Gemini is used)
    let augmentedMessages = messages;
    let ddgSources = [];
    if (webSearchEnabled && isGemini) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        const ddg = await duckDuckGoInstantAnswer(lastUserMsg.content);
        if (ddg.snippet) {
          augmentedMessages = messages.map((m) =>
            m === lastUserMsg ? { ...m, content: m.content + formatDDGSnippetForPrompt(ddg.snippet) } : m
          );
        }
        ddgSources = ddg.sources.map((s) => ({ ...s, provider: "duckduckgo" }));
      }
    }

    const streamOptions = {
      keyManager,
      modelChain,
      systemPrompt,
      messages: augmentedMessages,
      temperature,
      maxOutputTokens: maxTokens,
      signal: abortController.signal,
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => send("chunk", { text }),
      onRetry: () => send("reset", { reason: "Switching to a fallback model/key — restarting response." }),
    };

    // For Gemini, pass groundingEnabled; for Groq, it's ignored.
    if (isGemini) {
      streamOptions.groundingEnabled = webSearchEnabled;
    }

    const { modelUsed, keySuffixUsed, sources } = await streamFunc(streamOptions);

    // Merge sources only for Gemini
    let mergedSources = [];
    if (isGemini) {
      const taggedGeminiSources = (sources || []).map((s) => ({ ...s, provider: "google" }));
      const seenUris = new Set();
      mergedSources = [...taggedGeminiSources, ...ddgSources].filter((s) => {
        if (seenUris.has(s.uri)) return false;
        seenUris.add(s.uri);
        return true;
      });
    }

    if (mergedSources.length) send("sources", { sources: mergedSources });
    send("done", { modelUsed, keySuffixUsed, provider });
    safeEnd();
  } catch (err) {
    if (err.name === "AbortError") {
      send("aborted", { message: "Generation stopped." });
      return safeEnd();
    }
    // Handle provider-specific errors
    if (err instanceof GeminiError || err instanceof GroqError) {
      send("error", {
        type: err.errorType,
        message: err.message,
        attempts: err.attempts,
        retryAfterSeconds: err.suggestedRetrySeconds,
      });
      return safeEnd();
    }
    send("error", { type: "unknown", message: err.message });
    safeEnd();
  }
});

// ---- Non-streaming helpers (summary, title, suggestions) ----
// They default to Gemini but can accept a `provider` parameter.
async function nonStreamingComplete({ systemPrompt, userText, maxTokens = 200, signal, provider = "gemini" }) {
  // If provider is "groq" but groqKeyManager is not available, fallback to gemini.
  const func = (provider === "groq" && groqKeyManager) ? groqStream : geminiStream;
  const km = (provider === "groq" && groqKeyManager) ? groqKeyManager : geminiKeyManager;
  const chain = (provider === "groq" && groqKeyManager) ? GROQ_MODELS : GEMINI_MODELS;

  const result = await func({
    keyManager: km,
    modelChain: chain,
    systemPrompt,
    messages: [{ role: "user", content: userText }],
    temperature: 0.4,
    maxOutputTokens: maxTokens,
    signal,
    timeoutMs: TIMEOUT_MS,
  });
  return result.fullText.trim();
}

app.post("/api/summarize", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const summary = await nonStreamingComplete({
      systemPrompt:
        "You are SSC AI. Summarize the following conversation in 3-5 concise bullet points, capturing key questions and conclusions. Output only the bullets.",
      userText: conversationText.slice(0, 20000),
      maxTokens: 300,
      signal: req.signal,
      provider: provider || "gemini",
    });
    res.json({ summary });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/title", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const title = await nonStreamingComplete({
      systemPrompt:
        "Generate a short, specific chat title (max 6 words, no quotes, no punctuation at the end) summarizing this conversation's topic. Output ONLY the title text.",
      userText: conversationText.slice(0, 4000),
      maxTokens: 40,
      signal: req.signal,
      provider: provider || "gemini",
    });
    res.json({ title: title.replace(/^["']|["']$/g, "") });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/suggestions", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const raw = await nonStreamingComplete({
      systemPrompt:
        'Based on this conversation, suggest exactly 3 short natural follow-up questions the user might ask next. Output ONLY a JSON array of 3 strings, nothing else, e.g. ["...","...","..."]',
      userText: conversationText.slice(0, 6000),
      maxTokens: 150,
      signal: req.signal,
      provider: provider || "gemini",
    });
    let suggestions = [];
    try {
      suggestions = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    } catch (_) {
      suggestions = [];
    }
    res.json({ suggestions });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

// ---- Global error handler ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Unexpected server error" });
});

app.listen(PORT, () => {
  console.log(`SSC AI Backend running on port ${PORT}`);
  console.log(`Gemini models: ${GEMINI_MODELS.join(", ")}`);
  console.log(`Groq models: ${GROQ_MODELS.join(", ")}`);
  console.log(`Gemini keys: ${geminiKeyManager.size()}`);
  console.log(`Groq keys: ${groqKeyManager ? groqKeyManager.size() : 0}`);
});// src/index.js
// SSC AI Backend - Entry point.
// Supports Gemini and Groq providers.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { KeyManager } = require("./keyManager");
const { streamChat: geminiStream, AllProvidersExhaustedError: GeminiError } = require("./gemini");
const { streamChat: groqStream, AllProvidersExhaustedError: GroqError } = require("./groq");
const { buildSystemPrompt, getLiveClockBlock } = require("./systemPrompt");
const { duckDuckGoInstantAnswer, formatDDGSnippetForPrompt } = require("./duckduckgo");

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

// ---- Gemini config ----
const GEMINI_MODELS = (process.env.GEMINI_MODELS ||
  "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-1.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let geminiKeyManager;
try {
  geminiKeyManager = new KeyManager((process.env.GEMINI_API_KEYS || "").split(","));
} catch (err) {
  console.error("\n✗ Gemini keys missing: " + err.message);
  process.exit(1);
}

// ---- Groq config ----
const GROQ_MODELS = (process.env.GROQ_MODELS ||
  "llama-3.1-70b-versatile,llama-3.1-8b-instant,mixtral-8x7b-32768,gemma2-9b-it")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let groqKeyManager = null;
try {
  groqKeyManager = new KeyManager((process.env.GROQ_API_KEYS || "").split(","));
} catch (err) {
  console.warn("⚠ Groq keys not configured; Groq models will be unavailable.");
}

const app = express();
app.use(express.json({ limit: "12mb" }));

// ---- CORS ----
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

// ---- Rate limiting ----
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SSC AI Backend",
    time: getLiveClockBlock(),
    providers: {
      gemini: {
        models: GEMINI_MODELS,
        keys: geminiKeyManager.status(),
      },
      groq: groqKeyManager
        ? { models: GROQ_MODELS, keys: groqKeyManager.status() }
        : { available: false },
    },
  });
});

// ---- Main streaming endpoint ----
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
    model,
    provider: requestedProvider, // optional "gemini" or "groq"
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] is required" });
  }

  // Determine provider
  let provider = requestedProvider;
  if (!provider) {
    if (model && model.startsWith("groq-")) provider = "groq";
    else provider = "gemini";
  }
  // If provider is "groq" but no groqKeyManager, fallback to gemini
  if (provider === "groq" && !groqKeyManager) {
    console.warn("Groq requested but not configured – falling back to Gemini");
    provider = "gemini";
  }

  // Select the appropriate model chain and key manager
  let modelChain;
  let keyManager;
  let streamFunc;
  let isGemini = false;

  if (provider === "groq") {
    modelChain = model
      ? [model, ...GROQ_MODELS.filter((m) => m !== model)]
      : GROQ_MODELS;
    keyManager = groqKeyManager;
    streamFunc = groqStream;
  } else {
    // Gemini
    modelChain = model
      ? [model, ...GEMINI_MODELS.filter((m) => m !== model)]
      : GEMINI_MODELS;
    keyManager = geminiKeyManager;
    streamFunc = geminiStream;
    isGemini = true;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.on("error", () => {});

  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

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

    // Mastermind only supported for Gemini (simplified)
    if (mastermind && isGemini) {
      send("status", { stage: "mastermind-pass-1" });
      try {
        const pass1 = await geminiStream({
          keyManager: geminiKeyManager,
          modelChain: GEMINI_MODELS,
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
      } catch (e) {}
      send("status", { stage: "mastermind-pass-2" });
    }

    if (webSearchEnabled) send("status", { stage: "grounding" });

    // DuckDuckGo only for Gemini (and only if Gemini is used)
    let augmentedMessages = messages;
    let ddgSources = [];
    if (webSearchEnabled && isGemini) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        const ddg = await duckDuckGoInstantAnswer(lastUserMsg.content);
        if (ddg.snippet) {
          augmentedMessages = messages.map((m) =>
            m === lastUserMsg ? { ...m, content: m.content + formatDDGSnippetForPrompt(ddg.snippet) } : m
          );
        }
        ddgSources = ddg.sources.map((s) => ({ ...s, provider: "duckduckgo" }));
      }
    }

    const streamOptions = {
      keyManager,
      modelChain,
      systemPrompt,
      messages: augmentedMessages,
      temperature,
      maxOutputTokens: maxTokens,
      signal: abortController.signal,
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => send("chunk", { text }),
      onRetry: () => send("reset", { reason: "Switching to a fallback model/key — restarting response." }),
    };

    // For Gemini, pass groundingEnabled; for Groq, it's ignored.
    if (isGemini) {
      streamOptions.groundingEnabled = webSearchEnabled;
    }

    const { modelUsed, keySuffixUsed, sources } = await streamFunc(streamOptions);

    // Merge sources only for Gemini
    let mergedSources = [];
    if (isGemini) {
      const taggedGeminiSources = (sources || []).map((s) => ({ ...s, provider: "google" }));
      const seenUris = new Set();
      mergedSources = [...taggedGeminiSources, ...ddgSources].filter((s) => {
        if (seenUris.has(s.uri)) return false;
        seenUris.add(s.uri);
        return true;
      });
    }

    if (mergedSources.length) send("sources", { sources: mergedSources });
    send("done", { modelUsed, keySuffixUsed, provider });
    safeEnd();
  } catch (err) {
    if (err.name === "AbortError") {
      send("aborted", { message: "Generation stopped." });
      return safeEnd();
    }
    // Handle provider-specific errors
    if (err instanceof GeminiError || err instanceof GroqError) {
      send("error", {
        type: err.errorType,
        message: err.message,
        attempts: err.attempts,
        retryAfterSeconds: err.suggestedRetrySeconds,
      });
      return safeEnd();
    }
    send("error", { type: "unknown", message: err.message });
    safeEnd();
  }
});

// ---- Non-streaming helpers (summary, title, suggestions) ----
// They default to Gemini but can accept a `provider` parameter.
async function nonStreamingComplete({ systemPrompt, userText, maxTokens = 200, signal, provider = "gemini" }) {
  // If provider is "groq" but groqKeyManager is not available, fallback to gemini.
  const func = (provider === "groq" && groqKeyManager) ? groqStream : geminiStream;
  const km = (provider === "groq" && groqKeyManager) ? groqKeyManager : geminiKeyManager;
  const chain = (provider === "groq" && groqKeyManager) ? GROQ_MODELS : GEMINI_MODELS;

  const result = await func({
    keyManager: km,
    modelChain: chain,
    systemPrompt,
    messages: [{ role: "user", content: userText }],
    temperature: 0.4,
    maxOutputTokens: maxTokens,
    signal,
    timeoutMs: TIMEOUT_MS,
  });
  return result.fullText.trim();
}

app.post("/api/summarize", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const summary = await nonStreamingComplete({
      systemPrompt:
        "You are SSC AI. Summarize the following conversation in 3-5 concise bullet points, capturing key questions and conclusions. Output only the bullets.",
      userText: conversationText.slice(0, 20000),
      maxTokens: 300,
      signal: req.signal,
      provider: provider || "gemini",
    });
    res.json({ summary });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/title", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const title = await nonStreamingComplete({
      systemPrompt:
        "Generate a short, specific chat title (max 6 words, no quotes, no punctuation at the end) summarizing this conversation's topic. Output ONLY the title text.",
      userText: conversationText.slice(0, 4000),
      maxTokens: 40,
      signal: req.signal,
      provider: provider || "gemini",
    });
    res.json({ title: title.replace(/^["']|["']$/g, "") });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/suggestions", async (req, res) => {
  try {
    const { conversationText, provider } = req.body;
    if (!conversationText || typeof conversationText !== "string") {
      return res.status(400).json({ error: "conversationText (string) is required" });
    }
    const raw = await nonStreamingComplete({
      systemPrompt:
        'Based on this conversation, suggest exactly 3 short natural follow-up questions the user might ask next. Output ONLY a JSON array of 3 strings, nothing else, e.g. ["...","...","..."]',
      userText: conversationText.slice(0, 6000),
      maxTokens: 150,
      signal: req.signal,
      provider: provider || "gemini",
    });
    let suggestions = [];
    try {
      suggestions = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    } catch (_) {
      suggestions = [];
    }
    res.json({ suggestions });
  } catch (err) {
    if (err.name === "AbortError") return res.status(499).json({ error: "Request aborted" });
    res.status(500).json({ error: err.message });
  }
});

// ---- Global error handler ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Unexpected server error" });
});

app.listen(PORT, () => {
  console.log(`SSC AI Backend running on port ${PORT}`);
  console.log(`Gemini models: ${GEMINI_MODELS.join(", ")}`);
  console.log(`Groq models: ${GROQ_MODELS.join(", ")}`);
  console.log(`Gemini keys: ${geminiKeyManager.size()}`);
  console.log(`Groq keys: ${groqKeyManager ? groqKeyManager.size() : 0}`);
});

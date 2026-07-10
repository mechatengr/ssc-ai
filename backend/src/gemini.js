// src/gemini.js
// Core AI engine: iterates the model fallback chain, and within each model
// iterates the key rotation, streaming tokens back through onChunk() until
// one (key, model) pair succeeds or all are exhausted.

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { isQuotaError, extractRetryAfterSeconds } = require("./quota");

const clientCache = new Map(); // apiKey -> GoogleGenerativeAI instance

function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return clientCache.get(apiKey);
}

// Converts our simple {role: 'user'|'assistant', content: string}[] history
// into Gemini's {role: 'user'|'model', parts: [{text}]}[] format.
function toGeminiContents(messages) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
}

class AllProvidersExhaustedError extends Error {
  constructor(attempts) {
    super("All Gemini models/keys are currently unavailable (quota exhausted).");
    this.name = "AllProvidersExhaustedError";
    this.attempts = attempts;
  }
}

// Builds the `tools` array for native Gemini grounding. Gemini 2.0+ models
// use the "googleSearch" tool; Gemini 1.5 models use the older
// "googleSearchRetrieval" tool name. No separate search API key is needed —
// grounding runs entirely inside Google's infrastructure under the same
// Gemini API key.
function buildGroundingTools(modelName, groundingEnabled) {
  if (!groundingEnabled) return undefined;
  const isV2Plus = /gemini-2/.test(modelName);
  return isV2Plus ? [{ googleSearch: {} }] : [{ googleSearchRetrieval: {} }];
}

// Extracts a de-duplicated list of {title, uri} source citations from a
// grounded Gemini response, if any were returned.
function extractGroundingSources(aggregatedResponse) {
  try {
    const gm = aggregatedResponse?.candidates?.[0]?.groundingMetadata;
    const chunks = gm?.groundingChunks || [];
    const seen = new Set();
    const sources = [];
    for (const c of chunks) {
      const uri = c?.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ title: c.web.title || uri, uri });
    }
    return sources;
  } catch (_) {
    return [];
  }
}

/**
 * Streams a chat completion, trying models in order and rotating keys within
 * each model on quota errors. Calls onChunk(text) for every token chunk.
 * Returns { fullText, modelUsed, keySuffixUsed, sources }.
 */
async function streamChat({
  keyManager,
  modelChain,
  systemPrompt,
  messages,
  temperature = 0.7,
  maxOutputTokens = 2048,
  groundingEnabled = false,
  onChunk,
  onRetry, // called when a previous attempt already streamed partial text but then failed
  signal,
  timeoutMs = 30000,
}) {
  const contents = toGeminiContents(messages);
  const attempts = [];

  for (const modelName of modelChain) {
    const orderedKeys = keyManager.getOrderedKeys();

    for (const apiKey of orderedKeys) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // If the caller aborts (user hit Stop), propagate.
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort);

      let emittedAnyThisAttempt = false;

      try {
        const client = getClient(apiKey);
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction: systemPrompt,
        });

        const tools = buildGroundingTools(modelName, groundingEnabled);
        const request = { contents, generationConfig: { temperature, maxOutputTokens } };
        if (tools) request.tools = tools;

        const result = await model.generateContentStream(
          request,
          { signal: controller.signal, timeout: timeoutMs }
        );

        let fullText = "";
        for await (const chunk of result.stream) {
          if (signal?.aborted) break;
          const text = chunk.text();
          if (text) {
            fullText += text;
            emittedAnyThisAttempt = true;
            if (onChunk) onChunk(text);
          }
        }

        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        // Grounding citations (if any) only appear on the fully-aggregated
        // response, available once the stream has finished.
        let sources = [];
        if (tools) {
          try {
            const aggregated = await result.response;
            sources = extractGroundingSources(aggregated);
          } catch (_) {
            sources = [];
          }
        }

        attempts.push({ model: modelName, key: apiKey.slice(-4), ok: true });
        return { fullText, modelUsed: modelName, keySuffixUsed: apiKey.slice(-4), attempts, sources };
      } catch (err) {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          const abortErr = new Error("Generation aborted by user.");
          abortErr.name = "AbortError";
          throw abortErr;
        }

        const quota = isQuotaError(err);
        attempts.push({
          model: modelName,
          key: apiKey.slice(-4),
          ok: false,
          quota,
          message: err.message,
        });

        // A fallback attempt is about to start. If the failed attempt had
        // already streamed partial text to the client, tell the caller to
        // wipe that partial output first so the retry doesn't get appended
        // after stale/garbled text.
        if (emittedAnyThisAttempt && onRetry) onRetry();

        if (quota) {
          const retryAfter = extractRetryAfterSeconds(err);
          keyManager.markExhausted(apiKey, retryAfter);
          keyManager.advanceCursor();
          continue; // try next key (or fall through to next model)
        }

        // Non-quota error (bad request, safety block, etc.) - don't burn
        // through every key for this, but do try the next model in case the
        // issue is model-specific.
        break;
      }
    }
  }

  throw new AllProvidersExhaustedError(attempts);
}

module.exports = { streamChat, toGeminiContents, AllProvidersExhaustedError };

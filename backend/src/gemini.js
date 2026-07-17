// src/gemini.js
// Core AI engine: iterates the model fallback chain, and within each model
// iterates the key rotation, streaming tokens back through onChunk() until
// one (key, model) pair succeeds or all are exhausted.
//
// Uses @google/genai — the current, actively-maintained Gemini SDK. The
// previous SDK, @google/generative-ai, reached end-of-life and is no longer
// safe to depend on for new deployments.

const { GoogleGenAI } = require("@google/genai");
const { isQuotaError, extractRetryAfterSeconds } = require("./quota");

const clientCache = new Map(); // apiKey -> GoogleGenAI instance

function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new GoogleGenAI({ apiKey }));
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
    const anyQuota = attempts.some((a) => a.quota);
    const anyEmpty = attempts.some((a) => a.emptyResponse);
    const message = anyQuota
      ? "All Gemini models/keys are currently unavailable (quota exhausted)."
      : anyEmpty
      ? "Gemini returned no visible text across every available model. This can happen on ambiguous or edge-case prompts — try rephrasing your message."
      : "All Gemini models/keys are currently unavailable.";
    super(message);
    this.name = "AllProvidersExhaustedError";
    this.attempts = attempts;
    this.errorType = anyQuota ? "quota" : anyEmpty ? "empty" : "unknown";
    // Shortest retry-after hint among quota-exhausted attempts, if any were
    // provided by the API, so callers can show a real countdown instead of
    // a generic "try again shortly" message.
    const waits = attempts
      .filter((a) => a.quota && typeof a.retryAfterSeconds === "number")
      .map((a) => a.retryAfterSeconds);
    this.suggestedRetrySeconds = waits.length ? Math.min(...waits) : null;
  }
}

// Builds the `tools` array for native Gemini grounding (Google Search).
// No separate search API key is needed — grounding runs entirely inside
// Google's infrastructure under the same Gemini API key.
function buildGroundingTools(groundingEnabled) {
  if (!groundingEnabled) return undefined;
  return [{ googleSearch: {} }];
}

// Gemini 2.5 models default to spending part of maxOutputTokens on an
// invisible internal "thinking" budget before producing visible text. Our
// app already implements its own *visible* <thinking> mechanism via the
// system prompt (see systemPrompt.js's deepThink instructions), so native
// invisible thinking would silently compete for the same token budget —
// and on some prompts can consume the entire budget, leaving zero visible
// output even though the call "succeeded". We disable it explicitly so
// every output token goes to text the user actually sees.
function buildThinkingConfig(modelName) {
  if (!/gemini-2\.5/.test(modelName)) return undefined; // only 2.5-series supports this param
  return { thinkingBudget: 0 };
}

// Extracts a de-duplicated list of {title, uri} source citations from a
// collection of grounding chunks accumulated across the stream.
function extractGroundingSources(groundingChunks) {
  try {
    const seen = new Set();
    const sources = [];
    for (const c of groundingChunks) {
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

// Human-readable explanations for Gemini finishReason values, used when a
// response comes back with no visible text so the user gets a real
// explanation instead of a silent empty bubble.
const FINISH_REASON_MESSAGES = {
  SAFETY: "The response was blocked by Gemini's safety filters.",
  RECITATION: "The response was blocked due to potential copyrighted content overlap.",
  MAX_TOKENS: "The response hit the max token limit before producing visible text.",
  OTHER: "Gemini returned no visible text for this prompt.",
};

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
        const tools = buildGroundingTools(groundingEnabled);
        const thinkingConfig = buildThinkingConfig(modelName);

        const config = {
          systemInstruction: systemPrompt,
          temperature,
          maxOutputTokens,
          abortSignal: controller.signal,
          httpOptions: { timeout: timeoutMs },
        };
        if (tools) config.tools = tools;
        if (thinkingConfig) config.thinkingConfig = thinkingConfig;

        const stream = await client.models.generateContentStream({
          model: modelName,
          contents,
          config,
        });

        let fullText = "";
        let lastFinishReason = null;
        const groundingChunksAcc = [];
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const text = chunk.text;
          if (text) {
            fullText += text;
            emittedAnyThisAttempt = true;
            if (onChunk) onChunk(text);
          }
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) lastFinishReason = candidate.finishReason;
          // Grounding metadata streams in incrementally on whichever chunk(s)
          // carry it; accumulate across the whole response and de-dupe at
          // the end rather than assuming it's only on the final chunk.
          const gm = candidate?.groundingMetadata;
          if (gm?.groundingChunks?.length) groundingChunksAcc.push(...gm.groundingChunks);
        }

        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        const sources = tools ? extractGroundingSources(groundingChunksAcc) : [];

        attempts.push({ model: modelName, key: apiKey.slice(-4), ok: true, finishReason: lastFinishReason });

        // The call succeeded (no thrown error) but produced no visible text —
        // this used to show as a silent empty bubble. Surface why, and let
        // the caller decide whether to auto-retry with the next key/model.
        if (!fullText) {
          const reasonMsg = FINISH_REASON_MESSAGES[lastFinishReason] || FINISH_REASON_MESSAGES.OTHER;
          const emptyErr = new Error(reasonMsg);
          emptyErr.name = "EmptyResponseError";
          emptyErr.finishReason = lastFinishReason;
          throw emptyErr;
        }

        return { fullText, modelUsed: modelName, keySuffixUsed: apiKey.slice(-4), attempts, sources };
      } catch (err) {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          const abortErr = new Error("Generation aborted by user.");
          abortErr.name = "AbortError";
          throw abortErr;
        }

        if (err.name === "EmptyResponseError") {
          attempts[attempts.length - 1] = {
            ...attempts[attempts.length - 1],
            ok: false,
            emptyResponse: true,
            message: err.message,
          };
          // Try the next key for this model first (cheap), then fall through
          // to the next model in the chain if every key on this model comes
          // back empty — a different model may simply answer the prompt.
          continue;
        }

        const quota = isQuotaError(err);
        const retryAfter = quota ? extractRetryAfterSeconds(err) : null;
        attempts.push({
          model: modelName,
          key: apiKey.slice(-4),
          ok: false,
          quota,
          message: err.message,
          retryAfterSeconds: retryAfter,
        });

        // A fallback attempt is about to start. If the failed attempt had
        // already streamed partial text to the client, tell the caller to
        // wipe that partial output first so the retry doesn't get appended
        // after stale/garbled text.
        if (emittedAnyThisAttempt && onRetry) onRetry();

        if (quota) {
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

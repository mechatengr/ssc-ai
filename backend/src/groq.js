// src/groq.js
// Groq API integration – uses the official Groq SDK.
// Supports multiple API keys, rotation, and streaming.

const Groq = require('groq-sdk');   // <-- corrected require
const { isQuotaError, extractRetryAfterSeconds } = require('./quota');

const clientCache = new Map(); // apiKey -> Groq instance

function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new Groq({ apiKey }));
  }
  return clientCache.get(apiKey);
}

class AllProvidersExhaustedError extends Error {
  constructor(attempts, suggestedRetrySeconds = null) {
    const anyQuota = attempts.some((a) => a.quota);
    const anyEmpty = attempts.some((a) => a.emptyResponse);
    const message = anyQuota
      ? "All Groq models/keys are currently unavailable (quota exhausted)."
      : anyEmpty
      ? "Groq returned no visible text across every available model. Try rephrasing."
      : "All Groq models/keys are currently unavailable.";
    super(message);
    this.name = "AllProvidersExhaustedError";
    this.attempts = attempts;
    this.errorType = anyQuota ? "quota" : anyEmpty ? "empty" : "unknown";
    this.suggestedRetrySeconds = suggestedRetrySeconds;
  }
}

// Convert our message format to Groq's format
function toGroqMessages(messages) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

/**
 * Streams a chat completion using Groq.
 * Returns { fullText, modelUsed, keySuffixUsed, sources: [] } (sources always empty for Groq).
 */
async function streamChat({
  keyManager,
  modelChain,
  systemPrompt,
  messages,
  temperature = 0.7,
  maxOutputTokens = 2048,
  onChunk,
  onRetry,
  signal,
  timeoutMs = 30000,
}) {
  const orderedKeys = keyManager.getOrderedKeys();
  if (orderedKeys.length === 0) {
    const minCooldown = keyManager.getMinCooldown();
    const attempts = keyManager.status().map((s) => ({ model: "N/A", key: s.suffix, ok: false, quota: true, retryAfterSeconds: minCooldown }));
    throw new AllProvidersExhaustedError(attempts, minCooldown);
  }

  const groqMessages = toGroqMessages(messages);
  const attempts = [];

  for (const modelName of modelChain) {
    for (const apiKey of orderedKeys) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort);

      let emittedAnyThisAttempt = false;
      let fullText = "";

      try {
        const client = getClient(apiKey);
        const stream = await client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            ...groqMessages,
          ],
          temperature,
          max_tokens: maxOutputTokens,
          stream: true,
        });

        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            emittedAnyThisAttempt = true;
            if (onChunk) onChunk(token);
          }
        }

        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);

        attempts.push({ model: modelName, key: apiKey.slice(-4), ok: true });

        if (!fullText) {
          const emptyErr = new Error("Groq returned no visible text for this prompt.");
          emptyErr.name = "EmptyResponseError";
          throw emptyErr;
        }

        return { fullText, modelUsed: modelName, keySuffixUsed: apiKey.slice(-4), attempts, sources: [] };
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

        if (emittedAnyThisAttempt && onRetry) onRetry();

        if (quota) {
          keyManager.markExhausted(apiKey, retryAfter);
          keyManager.advanceCursor();
          continue;
        }

        // Non‑quota error – try next model
        break;
      }
    }
  }

  throw new AllProvidersExhaustedError(attempts);
}

module.exports = { streamChat, AllProvidersExhaustedError };

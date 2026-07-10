// src/quota.js
// Detects whether an error thrown by the Gemini SDK represents a quota /
// rate-limit condition (as opposed to a genuine bad-request or content error)
// so the caller can decide to rotate keys/models instead of failing outright.

function isQuotaError(err) {
  if (!err) return false;
  const status = err.status || err.code || (err.response && err.response.status);
  const message = String(err.message || "").toLowerCase();

  const quotaStatusCodes = [429, 403];
  const quotaKeywords = [
    "quota",
    "rate limit",
    "rate_limit",
    "resource exhausted",
    "resource_exhausted",
    "too many requests",
    "permission_denied", // sometimes returned for disabled/exhausted keys
  ];

  if (quotaStatusCodes.includes(Number(status))) return true;
  return quotaKeywords.some((kw) => message.includes(kw));
}

// Attempts to read a Retry-After style hint out of the error body/headers.
// Falls back to null if none is present.
function extractRetryAfterSeconds(err) {
  try {
    const headerVal =
      err?.response?.headers?.get?.("retry-after") ||
      err?.response?.headers?.["retry-after"];
    if (headerVal) {
      const n = parseInt(headerVal, 10);
      if (!Number.isNaN(n)) return n;
    }
    // Gemini sometimes embeds a RetryInfo object with a "retryDelay" like "23s"
    const msg = String(err.message || "");
    const match = msg.match(/retryDelay"?\s*:\s*"?(\d+)s/i);
    if (match) return parseInt(match[1], 10);
  } catch (_) {
    /* ignore */
  }
  return null;
}

module.exports = { isQuotaError, extractRetryAfterSeconds };

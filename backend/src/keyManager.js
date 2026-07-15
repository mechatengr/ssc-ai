// src/keyManager.js
// Rotates across multiple Gemini API keys and reports/records quota exhaustion
// so the same exhausted key isn't retried until its cooldown passes.

class KeyManager {
  constructor(keys) {
    this.keys = (keys || []).map((k) => k.trim()).filter(Boolean);
    if (this.keys.length === 0) {
      throw new Error("No GEMINI_API_KEYS configured.");
    }
    this.cursor = 0;
    // key -> timestamp (ms) until which the key should be skipped
    this.cooldowns = new Map();
  }

  size() {
    return this.keys.length;
  }

  isOnCooldown(key) {
    const until = this.cooldowns.get(key);
    return until && Date.now() < until;
  }

  markExhausted(key, retryAfterSeconds) {
    const cooldownMs = (retryAfterSeconds ? retryAfterSeconds : 60) * 1000;
    this.cooldowns.set(key, Date.now() + cooldownMs);
  }

  // Returns an ordered list of keys to try this request, starting from the
  // current rotation cursor, skipping keys still on cooldown (unless ALL are
  // on cooldown, in which case we try them anyway - a live 429 will tell us).
  getOrderedKeys() {
    const n = this.keys.length;
    const ordered = [];
    for (let i = 0; i < n; i++) {
      ordered.push(this.keys[(this.cursor + i) % n]);
    }
    const fresh = ordered.filter((k) => !this.isOnCooldown(k));
    return fresh.length > 0 ? fresh : ordered;
  }

  advanceCursor() {
    this.cursor = (this.cursor + 1) % this.keys.length;
  }

  status() {
    return this.keys.map((k, i) => ({
      index: i,
      suffix: k.slice(-4),
      onCooldown: this.isOnCooldown(k),
    }));
  }
}

module.exports = { KeyManager };

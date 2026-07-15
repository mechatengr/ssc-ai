# SSC AI — Backend

Node.js + Express backend powering **SSC AI** (Synergy Science Circle). Streams
Gemini responses over Server-Sent Events, with automatic API-key rotation,
model fallback, live-clock injection, Google web search grounding, and a
two-pass "Mastermind" reasoning mode.

## Endpoints

| Method | Path              | Purpose                                   |
|--------|-------------------|--------------------------------------------|
| GET    | `/api/health`     | Health check + key/model status            |
| POST   | `/api/chat`       | SSE streaming chat completion (grounding via `webSearchEnabled`) |
| POST   | `/api/summarize`  | AI-generated conversation summary           |
| POST   | `/api/title`      | AI-generated short chat title               |
| POST   | `/api/suggestions`| AI-generated follow-up question chips       |

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in your keys
npm start
```

Server runs on `http://localhost:3000` by default.

## Free deployment

This backend runs comfortably on any free Node.js host — e.g. **Render.com**
(free web service tier). See the full step-by-step PDF guide included in this
repo for exact click-by-click instructions (no terminal required).

## Environment variables

See `.env.example` for the full list. At minimum you need:
- `GEMINI_API_KEYS` — one or more free keys from https://aistudio.google.com/app/apikey

That's it — the Web Search toggle uses Gemini's **built-in Google Search
grounding tool**, which runs under your existing Gemini API key with no
separate search API key, engine ID, or setup required.

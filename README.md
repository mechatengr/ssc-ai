# SSC AI — Synergy Science Circle

*"United by Logic, Driven by Science."*

The official AI assistant of Synergy Science Circle — a full-stack AI chat
application with a streaming Gemini-powered backend, a feature-rich web app,
and a free, automatically-built native Android app.

## What's in this repo

```
ssc-ai/
├── backend/                 Node.js + Express API (Gemini streaming, key
│                             rotation, built-in Google Search grounding,
│                             Mastermind mode)
├── frontend/                 The SSC AI web app (ssc-ai.html + app.js) —
│                             also the source used to build the Android app
├── .github/workflows/        GitHub Actions pipeline that builds the
│                             Android APK in the cloud, for free
├── capacitor.config.json     Config that wraps the web app as an Android app
├── package.json               Drives the Android build in CI
└── SSC_AI_Setup_Guide.pdf     Full click-by-click setup guide (start here!)
```

## Quick start

**Read `SSC_AI_Setup_Guide.pdf` first** — it walks through everything below
from a phone browser, with no terminal commands required:

1. Get free Gemini API keys.
2. Deploy `backend/` to a free host (Render.com).
3. Point `frontend/app.js`'s `backendUrl` (or the in-app Settings → General
   field) at your deployed backend.
4. Push this repo to GitHub — the included GitHub Action automatically
   builds an Android APK and publishes it to your repo's **Releases** page.
5. Open the release on your phone and install the APK directly.

Everything used here — Gemini's free tier (which includes built-in Google
Search grounding for the Web Search toggle, no separate search API key
needed), Render's free web service tier, and GitHub Actions' free minutes
for public repos — has no cost.

## Local development

```bash
# Backend
cd backend
npm install
cp .env.example .env   # fill in your keys
npm start

# Frontend
# Just open frontend/ssc-ai.html in a browser, or serve the folder with any
# static file server. Set the backend URL in Settings → General.
```

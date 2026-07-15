/* SSC AI — Service Worker
   Caches the app shell so the interface loads instantly (even offline),
   while all backend API calls (chat, health checks, etc.) always go to the
   network — cached AI responses would be stale and misleading, so we never
   intercept those. Bump CACHE_VERSION whenever app.js/ssc-ai.html change in
   a way that should invalidate old cached copies. */

const CACHE_VERSION = "ssc-ai-shell-v1";
const APP_SHELL = [
  "./ssc-ai.html",
  "./app.js",
  "./manifest.json",
  "./assets/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      /* Some assets may fail to precache (e.g. offline install) — that's
         fine, they'll be cached opportunistically on first successful fetch. */
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Never intercept API calls (backend chat/health/etc.) or anything that
// isn't a simple GET — those must always hit the live network.
function isApiRequest(url) {
  return url.pathname.startsWith("/api/") || url.href.includes("/api/chat") ||
         url.href.includes("/api/health") || url.href.includes("/api/summarize") ||
         url.href.includes("/api/title") || url.href.includes("/api/suggestions");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // let POSTs (chat, etc.) pass straight through

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Only handle same-origin requests (the app shell itself). Cross-origin
  // resources (CDN libraries, Google Fonts) are intentionally left
  // untouched and go straight through the browser's normal fetch path —
  // proxying third-party requests through the service worker's own fetch()
  // adds risk (opaque responses can't be verified or evicted cleanly) for
  // no real offline benefit, since those libraries rarely change.
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return; // always network for backend calls

  // Same-origin app shell: cache-first, falling back to network, and
  // opportunistically caching whatever we fetch so repeat visits work
  // offline too.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached — for a navigation request, fall back to
          // the cached app shell so the UI still loads (data just won't).
          if (req.mode === "navigate") return caches.match("./ssc-ai.html");
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});

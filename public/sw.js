// Ichikawa service worker — small, robust, offline-tolerant.
//
// Strategy:
//   • App shell ("/") → cache-first (built JS/CSS are content-hashed, so a runtime
//     cache picks them up on first fetch and serves them offline thereafter).
//   • /api/recipes → network-first (fresh corpus when online, last-known when offline).
// Any caching failure is swallowed so the app never breaks because of the SW.

const CACHE = "ichikawa-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()).catch(() => {})
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, fall back to cached copy.
  if (url.pathname.startsWith("/api/recipes")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // App shell + hashed assets: cache-first, populate the runtime cache on miss.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          req.mode === "navigate" ? caches.match("/index.html") : Response.error()
        );
    })
  );
});

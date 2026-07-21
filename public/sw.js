// Ichikawa service worker — small, robust, offline-tolerant.
//
// Strategy:
//   • HTML navigations ("/", "/index.html") → NETWORK-FIRST. index.html is the
//     one un-hashed file, and it names the current content-hashed JS/CSS bundle.
//     Serving it network-first means a fresh deploy is picked up on the next
//     launch (falling back to the cached shell only when offline). Cache-first
//     here would pin an installed PWA to the FIRST index.html it ever saw — and
//     thus to a stale bundle — forever; that is the bug this replaces.
//   • Hashed assets (/assets/*, fonts, icons) → cache-first. Their URLs are
//     immutable, so a new build ships new URLs and never serves stale code.
//   • /api/recipes → network-first (fresh corpus when online, last-known offline).
// Any caching failure is swallowed so the app never breaks because of the SW.
//
// Bump CACHE on every shape change so `activate` purges the previous version's
// pinned shell from already-installed clients.
const CACHE = "ichikawa-v2";
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

// Network-first: fetch fresh, refresh the cache, fall back to the cached copy
// (or the shell for navigations) when the network is unavailable.
function networkFirst(req, fallbackPath) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() =>
      caches.match(req).then((r) => r || (fallbackPath ? caches.match(fallbackPath) : Response.error()))
    );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, fall back to cached copy.
  if (url.pathname.startsWith("/api/recipes")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // HTML shell + SPA navigations: network-first so a new deploy is picked up,
  // cached "/index.html" as the offline fallback.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(networkFirst(req, "/index.html"));
    return;
  }

  // Content-hashed assets: cache-first, populate the runtime cache on miss.
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
        .catch(() => Response.error());
    })
  );
});

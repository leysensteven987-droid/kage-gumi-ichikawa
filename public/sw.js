// Ichikawa service worker — small, robust, offline-tolerant.
//
// Strategy:
//   • Navigations / index.html → network-first. The shell is NOT content-hashed,
//     so it must be re-fetched when online or a new deploy stays invisible: a stale
//     cached index.html keeps pointing at the previous (hashed) JS bundle. Falls
//     back to the cached shell offline.
//   • Hashed assets (JS/CSS under /assets, fonts, icons) → cache-first. Their URL
//     changes when their content does, so a cached copy is always safe and fast.
//   • /api/recipes → network-first (fresh corpus when online, last-known when offline).
// Any caching failure is swallowed so the app never breaks because of the SW.
//
// CACHE name is versioned: bump it whenever the shell caching contract changes so
// the activate handler purges older caches (e.g. a stale cache-first index.html).

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

// Network-first: try the network, cache a fresh copy, fall back to cache when offline.
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
      caches.match(req).then((r) => r || (fallbackPath ? caches.match(fallbackPath) : undefined) || Response.error())
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

  // App shell: navigations and the bare index.html are network-first so a new
  // deploy's shell (pointing at the new hashed bundle) is picked up when online.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(networkFirst(req, "/index.html"));
    return;
  }

  // Hashed assets: cache-first, populate the runtime cache on miss.
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

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
//
// Bumped to v6 on 05AUG26 (ported from Tōge's sw.js, commit 9ed2212): lock.mjs's gate used
// to answer every un-cookied GET outside /api/ with its lock page at 200 text/html —
// including this file's own SHELL entries and any hashed asset URL. networkFirst() and
// cache.put() only checked response.ok, so that HTML could get stored under a URL that should
// only ever be JS/CSS/JSON, poisoning the install past the next real unlock. poisonsCache()
// below refuses to cache a text/html body under any URL that isn't a real HTML entry;
// install() now fetches SHELL one URL at a time under that guard instead of cache.addAll(), so
// one gated URL can no longer abort the whole precache; and this version bump makes
// activate()'s existing "delete every other cache" sweep self-heal a client that got poisoned
// before this fix shipped.
const CACHE = "ichikawa-v6";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg?v=2", "/apple-touch-icon.png?v=2"];

// The only URLs a text/html body is allowed to sit under — a navigation resolves to "/" or
// "/index.html". Everything else in SHELL and every hashed asset is JSON/SVG/PNG/JS/CSS and
// must never be HTML: that is precisely what lock.mjs's un-cookied-GET lock page looks like
// once it lands under one of them.
const HTML_URLS = new Set(["/", "/index.html"]);

// True when caching `response` under `url` would poison the cache: an HTML body (the shape of
// lock.mjs's lock page, or any other gate/error page a proxy might inject) landing on a URL that
// is supposed to be something else. Same-origin only — a third-party host answering its own
// content-type is not this file's problem.
function poisonsCache(url, response) {
  if (!response || url.origin !== self.location.origin) return false;
  if (HTML_URLS.has(url.pathname)) return false;
  const ct = response.headers.get("content-type") || "";
  return ct.includes("text/html");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(SHELL.map((path) => {
      const request = new Request(path);
      // Per-URL fetch instead of cache.addAll(path) — addAll() fails the WHOLE precache the
      // instant one URL 404s or (since the lock gate landed) comes back a 200 text/html lock
      // page for an un-cookied install, which would mean a locked client never gets an app
      // shell cached at all. A URL that fails the fetch or fails the guard is just skipped.
      return fetch(request)
        .then((response) => {
          if (response && response.ok && !poisonsCache(new URL(path, self.location.origin), response)) {
            return cache.put(request, response);
          }
          return null;
        })
        .catch(() => null);
    })))
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
  const url = new URL(req.url);
  return fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic" && !poisonsCache(url, res)) {
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

  // API: network-first, fall back to cached copy. The whole /api/ prefix, not
  // just /api/recipes — the default branch below is CACHE-FIRST, so any API
  // route that isn't listed here would be answered from a stale copy forever
  // (the pantry would never see what another device put on the shelf).
  if (url.pathname.startsWith("/api/")) {
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
          if (res && res.ok && res.type === "basic" && !poisonsCache(url, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => Response.error());
    })
  );
});

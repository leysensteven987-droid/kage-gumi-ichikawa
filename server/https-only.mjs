// server/https-only.mjs — force HTTPS on the public Cloudflare Tunnel hostname.
//
// The tunnel answers plain http just as happily as https: the kage-gumi.com zone has
// no "Always Use HTTPS" rule, so http://<app>.kage-gumi.com/ returns a 200. Typing the
// bare hostname therefore lands on an insecure page, the browser marks the tab "Not
// secure", and the passphrase form in lock.mjs posts in CLEARTEXT to the Cloudflare
// edge. Found 2026-08-03 on toge.kage-gumi.com and true of every app on the tunnel.
//
// Mount BEFORE lock — the passphrase page must never be rendered over http in the
// first place.
//
// Scoped on the Host header, not on x-forwarded-proto alone. cloudflared is the only
// entry point that can be http-fronted; loopback (http://localhost:<port>) and the
// tailnet path must NOT be bounced to an https port that isn't listening. cloudflared
// sets x-forwarded-proto on every hop, so its ABSENCE means a direct caller — left alone.
//
// HSTS is host-scoped on purpose: no `includeSubDomains` (that would speak for the whole
// kage-gumi.com zone, including the grey-cloud GitHub Pages apex serving the decks) and
// no `preload`. To unwind, serve `max-age=0` here and let browsers age out.

const PUBLIC_SUFFIX = ".kage-gumi.com";
const HSTS = "max-age=31536000"; // 1 year, this host only

export default function httpsOnly(req, res, next) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host.endsWith(PUBLIC_SUFFIX)) return next();

  const proto = req.headers["x-forwarded-proto"];
  if (proto === "http") {
    // 301, not 302: this is permanent for a public hostname, and a cached redirect is
    // one fewer cleartext round trip next time.
    res.writeHead(301, { Location: `https://${host}${req.originalUrl || req.url}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (proto === "https") res.setHeader("Strict-Transport-Security", HSTS);
  next();
}

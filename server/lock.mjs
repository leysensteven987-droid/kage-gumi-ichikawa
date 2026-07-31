// server/lock.mjs — Ichikawa 市川 passphrase gate.
//
// Zero npm deps (Node `crypto` + hand-parsed cookies only). Fronts every request
// with a single shared passphrase so the app can sit behind a public Cloudflare
// Tunnel hostname (ichikawa.kage-gumi.com) without being wide open. Modelled on
// kage-gumi's own frontend/server/auth.mjs (stateless HMAC session cookie +
// constant-time compare) but stripped down to ONE global passphrase, no
// identities, no modes — proportionate to a single-owner personal app.
//
// Env:
//   LOCK_PASSPHRASE       the shared unlock passphrase. UNSET ⇒ the gate is a
//                         no-op pass-through — local dev without the var still
//                         works, and a missing var can never silently lock
//                         everyone out.
//   LOCK_SESSION_SECRET   HMAC key signing the session cookie. Only read when
//                         LOCK_PASSPHRASE is set.
//
// Mount as the FIRST middleware — before express.static and before any API
// route (including /api/recipes/add and the photo-inbox routes, which ride the
// same app instance) — so nothing is reachable unauthenticated.

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ichikawa_lock";
const TTL_SECONDS = 30 * 24 * 3600; // ~30 days

// Public app-shell assets pass the gate. An icon or manifest request can arrive
// WITHOUT the session cookie (iOS fetches the apple-touch-icon when the app is
// added to the home screen), and answering it with the lock page's HTML at 200
// hands the OS an "image" that is not one — that is how you get a blank
// letter-tile icon. These files carry no data worth gating.
const PUBLIC_ASSETS = new Set(["/icon.svg", "/apple-touch-icon.png", "/manifest.webmanifest", "/favicon.ico", "/sw.js"]);

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (str) => Buffer.from(str, "base64url");

const passphrase = () => process.env.LOCK_PASSPHRASE || "";
const cookieSecret = () => process.env.LOCK_SESSION_SECRET || "";

// Constant-time compare — hash both sides to a fixed 32 bytes first so
// timingSafeEqual never throws on a length mismatch (which would itself leak
// length and crash the request). Mirrors safeEqual() in kage-gumi's auth.mjs.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHmac("sha256", "lock-cmp").update(a).digest();
  const hb = createHmac("sha256", "lock-cmp").update(b).digest();
  try {
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

function sign(payloadB64) {
  return createHmac("sha256", cookieSecret()).update(payloadB64).digest("base64url");
}

function issueToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + TTL_SECONDS };
  const p = b64u(JSON.stringify(payload));
  return `${p}.${sign(p)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  if (!cookieSecret()) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const p = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected;
  try {
    expected = sign(p);
  } catch {
    return false;
  }
  let ok = false;
  try {
    const a = unb64u(mac);
    const b = unb64u(expected);
    ok = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) return false;
  let claims;
  try {
    claims = JSON.parse(unb64u(p).toString("utf8"));
  } catch {
    return false;
  }
  if (!claims || typeof claims.exp !== "number") return false;
  return claims.exp > Math.floor(Date.now() / 1000);
}

function readCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

// Cloudflare Tunnel sets this on the HTTPS hop; plain Tailscale traffic
// (http://kg-honbu:5273) never does. Only add `Secure` when we know we're
// actually on HTTPS — an unconditional Secure cookie would silently break the
// Tailscale path.
const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

function cookieHeader(token, req) {
  const bits = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${TTL_SECONDS}`];
  if (isHttps(req)) bits.push("Secure");
  return bits.join("; ");
}

// Cloudflare's cache key ignores cookies, so a cacheable lock-gate response gets
// stored under whatever URL was requested — including asset URLs like icon.svg —
// and then served to authenticated users too. Every response the gate itself
// produces must opt out of caching at the edge, not just the browser.
function noStore(res) {
  res.setHeader("Cache-Control", "no-store, private, max-age=0");
  res.setHeader("Vary", "Cookie");
  return res;
}

// Read the raw request body — only ever called for POST /__unlock, before any
// body-parser middleware has run (lock is mounted first, ahead of both the
// small default json() parser and the photo route's own 25mb parser). Capped
// at 8kb: a passphrase post is a handful of bytes, never legitimately more.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8192) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!tooBig) resolve(data);
    });
    req.on("error", reject);
  });
}

function extractPassphrase(raw, contentType) {
  const ct = String(contentType || "");
  if (ct.includes("application/json")) {
    try {
      const body = JSON.parse(raw || "{}");
      return typeof body.passphrase === "string" ? body.passphrase : "";
    } catch {
      return "";
    }
  }
  // Form-urlencoded fallback — covers both the no-JS <form> submit and a plain
  // `curl -d "passphrase=..."` call.
  const params = new URLSearchParams(raw || "");
  return params.get("passphrase") || "";
}

// ─── Ichikawa 市川 lock page — sakura pink on warm rice-cream ─────────────────
function lockPageHtml({ wrong = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ichikawa — locked</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #FFF6EA; color: #5B4750;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 340px; background: #FFFDF9;
    border: 1px solid #F0DFCD; border-radius: 16px;
    padding: 32px 28px; text-align: center;
    box-shadow: 0 20px 50px rgba(91,71,80,.14);
  }
  .glyph { font-size: 40px; line-height: 1; margin-bottom: 10px; }
  h1 { font-size: 15px; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 20px; color: #5B4750; opacity: .85; }
  input[type=password] {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #F0DFCD;
    background: #FFF6EA; color: #5B4750; font-size: 15px; margin-bottom: 14px;
  }
  input[type=password]:focus { outline: none; border-color: #FF9DB2; }
  button {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: none;
    background: #FF9DB2; color: #FFFDF9; font-size: 14px; font-weight: 700;
    letter-spacing: .02em; cursor: pointer;
  }
  button:active { opacity: .85; }
  .msg { min-height: 18px; font-size: 13px; color: #F26D8B; margin-top: 12px; }
</style>
</head>
<body>
  <form class="card" id="f" method="POST" action="/__unlock">
    <div class="glyph">🐼</div>
    <h1>市川 — locked</h1>
    <input type="password" id="p" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
    <button type="submit">Unlock</button>
    <div class="msg" id="m">${wrong ? "wrong passphrase" : ""}</div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async function (e) {
      e.preventDefault();
      var m = document.getElementById('m');
      m.textContent = '';
      try {
        var r = await fetch('/__unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: document.getElementById('p').value })
        });
        if (r.ok) { window.location.href = '/'; return; }
        m.textContent = 'wrong passphrase';
      } catch (err) {
        m.textContent = 'could not reach the server — try again';
      }
    });
  </script>
</body>
</html>`;
}

export default function lock(req, res, next) {
  const pass = passphrase();
  if (!pass) return next(); // gate not configured — no-op pass-through

  // The unlock endpoint itself must always be reachable, or nobody could ever
  // pass the gate. Handled before the cookie check so a fresh unlock always works.
  if (req.method === "POST" && req.path === "/__unlock") {
    const ct = req.headers["content-type"];
    readBody(req)
      .then((raw) => {
        const supplied = extractPassphrase(raw, ct);
        if (!cookieSecret()) {
          console.error("[lock] LOCK_SESSION_SECRET is not set — cannot issue a session");
          noStore(res).status(500).send(lockPageHtml({ wrong: true }));
          return;
        }
        if (safeEqual(supplied, pass)) {
          res.setHeader("Set-Cookie", cookieHeader(issueToken(), req));
          res.writeHead(302, { Location: "/" });
          res.end();
        } else {
          noStore(res).status(401).send(lockPageHtml({ wrong: true }));
        }
      })
      .catch(() => {
        noStore(res).status(400).send(lockPageHtml({ wrong: true }));
      });
    return;
  }

  // Public app-shell assets pass the gate. An icon or manifest request can arrive
  // WITHOUT the session cookie (iOS fetches the apple-touch-icon when the app is
  // added to the home screen), and answering it with the lock page's HTML at 200
  // hands the OS an "image" that is not one — that is how you get a blank
  // letter-tile icon. These files carry no data worth gating.
  if (req.method === "GET" && PUBLIC_ASSETS.has(req.path)) return next();

  if (verifyToken(readCookie(req, COOKIE_NAME))) return next();

  // /api/* always gets JSON, regardless of method — a script/fetch client should
  // never have to parse HTML to discover it's locked out.
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    noStore(res).status(200).send(lockPageHtml());
    return;
  }

  noStore(res).status(401).json({ error: "locked" });
}

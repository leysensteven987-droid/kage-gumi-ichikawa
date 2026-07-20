/**
 * @vibe-author STLE @version 1 @date 05JUL26 @comment discover + extract past-delivery recipe URLs from HelloFresh account history
 *
 * pull-box-history.mjs
 *
 * Ichikawa recipe-engine Phase 2. Uses the saved HelloFresh Belgium session
 * (storageState) to visit the account's "my deliveries" / order-history area,
 * DISCOVERS the real API shape by instrumenting network responses (the exact
 * endpoints are unknown up front — this is recon-and-adapt, not a known-API call),
 * and collects the set of recipe DETAIL page URLs that were actually part of a
 * past delivered box. Falls back to DOM anchor scraping if the API route proves
 * too hard to parse. Read-only — GET/navigation only, never places or changes an order.
 *
 * Output:
 *   data/box-history-urls.txt   (one recipe detail URL per line)
 *   stdout: { count, urls, notes }           (machine-readable summary)
 *   stderr: recon progress + discovered JSON endpoint shapes
 *
 * Run:
 *   node engine/pull-box-history.mjs   (or: npm run pull)
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Anchor data/ at the repo root regardless of cwd (one level up from this engine/ file's dir).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data');
const SESSION_FILE = path.join(OUT_DIR, '.hf-session.json');
const URLS_OUT_FILE = path.join(OUT_DIR, 'box-history-urls.txt');

const BASE = 'https://www.hellofresh.be';

// Same UA the sibling scripts use — a stock headless UA is a Datadome tell.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

// Candidate account/deliveries pages to try, in order of likelihood. Any that bounce
// to /login are logged and skipped — they don't abort the run.
const CANDIDATE_PATHS = [
  '/my-deliveries',
  '/myaccount',
  '/my-account',
  '/menus',
  '/account/deliveries',
  '/deliveries',
  '/order-history',
  '/menus/planned',
  '/settings/deliveries',
];

const RECIPE_URL_RE = /\/recipes\/([a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{6,})/i;
const CANONICAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{6,}$/i;

function canonicalRecipeUrl(slug) {
  return `${BASE}/recipes/${slug}`;
}

function normalizeMaybeRelative(href) {
  try {
    return new URL(href, BASE).toString();
  } catch {
    return null;
  }
}

/**
 * HelloFresh does NOT always redirect an unauthenticated request off an account-only
 * route to /login — some routes just render a 200 "pagina niet gevonden" (404-content)
 * page with an "Inloggen" (log in) nav link still showing, while the URL itself never
 * changes. Checking the URL alone is not a reliable authenticated/not-authenticated
 * signal — this inspects the rendered body text as a second, independent check.
 */
async function pageLooksAuthenticated(page) {
  let bodyText;
  try {
    bodyText = await page.evaluate(() => document.body.innerText);
  } catch {
    return { ok: true, reason: 'body-text-check-failed-inconclusive' };
  }
  if (!bodyText) return { ok: true, reason: 'empty-body-inconclusive' };

  const hasNotFound = /pagina niet gevonden|page not found|404[:\s]/i.test(bodyText);
  const hasLoginLink = /\b(inloggen|log ?in|sign ?in)\b/i.test(bodyText);
  const hasLogoutLink = /\b(uitloggen|log ?out|sign ?out)\b/i.test(bodyText);

  if (hasNotFound) return { ok: false, reason: '404-not-found-content-rendered' };
  if (hasLoginLink && !hasLogoutLink) return { ok: false, reason: 'login-link-present-no-logout-link' };
  return { ok: true, reason: null };
}

/**
 * Recursively walk an arbitrary JSON value looking for recipe references.
 * - `found`: URLs we're confident about (canonical slug pattern, or a URL/path that
 *   already contains the full "/recipes/<slug>-<hexid>" shape).
 * - `ambiguous`: heuristic slug+id combinations we are NOT confident about (flagged,
 *   not written to the main output — surfaced only in notes).
 */
function collectRecipeRefs(value, found, ambiguous, depth = 0) {
  if (value == null || depth > 12) return;

  if (typeof value === 'string') {
    const m = value.match(RECIPE_URL_RE);
    if (m) found.add(canonicalRecipeUrl(m[1]));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectRecipeRefs(item, found, ambiguous, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    const slug = typeof value.slug === 'string' ? value.slug.trim() : null;
    if (slug && CANONICAL_SLUG_RE.test(slug)) {
      found.add(canonicalRecipeUrl(slug));
    } else if (slug && (value.id || value.recipeId || value._id)) {
      const rid = String(value.id || value.recipeId || value._id).trim();
      if (/^[a-f0-9]{6,}$/i.test(rid)) {
        // Heuristic guess only — real HelloFresh slugs already embed the hex suffix;
        // this combination is not verified against a real recipe page.
        ambiguous.add(`${slug}-${rid}`);
      }
    }

    for (const key of ['websiteUrl', 'url', 'link', 'cardLink', 'href', 'path', 'permalink']) {
      if (typeof value[key] === 'string') collectRecipeRefs(value[key], found, ambiguous, depth + 1);
    }

    for (const k of Object.keys(value)) {
      collectRecipeRefs(value[k], found, ambiguous, depth + 1);
    }
  }
}

async function main() {
  const notes = [];

  if (!fs.existsSync(SESSION_FILE)) {
    console.error(`[ichikawa] No saved session at ${SESSION_FILE}.`);
    console.error('[ichikawa] Run capture-hellofresh-session.mjs first.');
    console.log(JSON.stringify({ count: 0, urls: [], notes: ['no-session-file'] }, null, 2));
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.error('[ichikawa] Launching headless browser with saved session...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: BROWSER_UA,
    viewport: { width: 1366, height: 900 },
  });

  const foundUrls = new Set();
  const ambiguousGuesses = new Set();
  const capturedResponses = []; // { url, status, text }
  const seenEndpointPatterns = new Set();
  const paginationCandidates = new Set();

  const page = await context.newPage();

  page.on('response', async (res) => {
    let u;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (!/hellofresh/i.test(u.hostname)) return;

    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;

    let text;
    try {
      text = await res.text();
    } catch {
      return;
    }
    if (!text) return;

    // Cap what we hold in memory for very large payloads — still log that we saw it.
    if (text.length <= 5_000_000) {
      capturedResponses.push({ url: res.url(), status: res.status(), text });
    }

    const patternKey = `${u.hostname}${u.pathname}`;
    if (!seenEndpointPatterns.has(patternKey)) {
      seenEndpointPatterns.add(patternKey);
      console.error(`[ichikawa] JSON endpoint seen: ${res.status()} ${patternKey}`);
      console.error(`[ichikawa]   sample: ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
      if (/deliver|order|subscription|box|week|menu/i.test(u.pathname)) {
        paginationCandidates.add(res.url());
      }
    }
  });

  let authenticatedHits = 0;
  let bounceCount = 0;

  for (const p of CANDIDATE_PATHS) {
    const url = `${BASE}${p}`;
    console.error(`[ichikawa] Visiting ${url} ...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (err) {
      console.error(`[ichikawa]   navigation failed: ${err.message}`);
      continue;
    }

    // Let any post-load XHR/fetch calls settle.
    await page.waitForTimeout(3500);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const finalUrl = page.url();
    if (/\/login/i.test(finalUrl)) {
      bounceCount++;
      console.error(`[ichikawa]   bounced to login (${finalUrl}) — skipping this route.`);
      continue;
    }

    const authCheck = await pageLooksAuthenticated(page);
    if (!authCheck.ok) {
      bounceCount++;
      console.error(`[ichikawa]   NOT authenticated (${authCheck.reason}) at ${finalUrl} — skipping this route.`);
      continue;
    }

    authenticatedHits++;
    console.error(`[ichikawa]   stayed authenticated at ${finalUrl}`);

    // Try to read Next.js-style embedded page-props JSON (common SPA server-render pattern).
    try {
      const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el || !el.textContent) return null;
        try {
          return JSON.parse(el.textContent);
        } catch {
          return null;
        }
      });
      if (nextData) {
        console.error('[ichikawa]   found __NEXT_DATA__ — scanning for recipe refs');
        collectRecipeRefs(nextData, foundUrls, ambiguousGuesses);
      }
    } catch {
      // best-effort only
    }

    // DOM fallback: scrape any anchors pointing at recipe detail pages.
    try {
      const hrefs = await page.$$eval('a[href*="/recipes/"]', (els) =>
        els.map((e) => e.getAttribute('href'))
      );
      for (const href of hrefs) {
        if (!href) continue;
        const abs = normalizeMaybeRelative(href);
        if (abs && RECIPE_URL_RE.test(abs)) {
          const m = abs.match(RECIPE_URL_RE);
          foundUrls.add(canonicalRecipeUrl(m[1]));
        }
      }
      if (hrefs.length) {
        console.error(`[ichikawa]   DOM scrape found ${hrefs.length} recipe anchor(s) on this page.`);
      }
    } catch {
      // page may not have that selector — fine
    }
  }

  if (authenticatedHits === 0) {
    notes.push('SESSION_NOT_AUTHENTICATED: every candidate account route either redirected to /login or rendered as not-logged-in (404-content / login-link-present) — the saved session is not carrying a valid customer login. Re-run capture-hellofresh-session.mjs and confirm the browser window actually shows the logged-in account before it saves.');
    console.error('[ichikawa] WARNING: every candidate route was unauthenticated. Session is not actually logged in.');
  } else if (bounceCount > 0) {
    notes.push(`${bounceCount}/${CANDIDATE_PATHS.length} candidate routes were unauthenticated (redirect or login-link-detected); the rest stayed authenticated.`);
  }

  // Scan every captured JSON XHR/fetch response body for recipe refs too.
  for (const resp of capturedResponses) {
    try {
      const parsed = JSON.parse(resp.text);
      collectRecipeRefs(parsed, foundUrls, ambiguousGuesses);
    } catch {
      // not JSON, or truncated — the raw-string regex pass below still has a shot
      const m = resp.text.match(RECIPE_URL_RE);
      if (m) foundUrls.add(canonicalRecipeUrl(m[1]));
    }
  }

  // Best-effort pagination: replay a handful of "deliveries/orders/weeks"-shaped endpoints
  // with a page param, reusing the authenticated context (cookies carry over automatically).
  // Bounded and non-fatal — this is exploratory, not a confirmed API contract.
  for (const baseUrl of paginationCandidates) {
    console.error(`[ichikawa] Attempting pagination replay of: ${baseUrl}`);
    try {
      const u = new URL(baseUrl);
      let gotAny = false;
      for (let pageNum = 2; pageNum <= 6; pageNum++) {
        const pu = new URL(u.toString());
        pu.searchParams.set('page', String(pageNum));
        let resp;
        try {
          resp = await context.request.get(pu.toString(), { timeout: 15000 });
        } catch (err) {
          console.error(`[ichikawa]   page ${pageNum} request failed: ${err.message}`);
          break;
        }
        if (!resp.ok()) {
          console.error(`[ichikawa]   page ${pageNum} -> HTTP ${resp.status()}, stopping pagination.`);
          break;
        }
        const text = await resp.text().catch(() => '');
        if (!text) break;
        gotAny = true;
        console.error(`[ichikawa]   page ${pageNum} OK (${text.length} bytes)`);
        try {
          collectRecipeRefs(JSON.parse(text), foundUrls, ambiguousGuesses);
        } catch {
          const m = text.match(RECIPE_URL_RE);
          if (m) foundUrls.add(canonicalRecipeUrl(m[1]));
        }
      }
      if (gotAny) notes.push(`Paginated replay attempted against ${u.pathname} (page= param) — unverified whether this endpoint actually supports that param.`);
    } catch (err) {
      console.error(`[ichikawa]   pagination attempt errored: ${err.message}`);
    }
  }

  if (ambiguousGuesses.size > 0) {
    notes.push(
      `${ambiguousGuesses.size} recipe reference(s) found as separate slug+id fields with no confirmed canonical slug — NOT included in the output (too speculative to guarantee a valid URL). Sample: ${[...ambiguousGuesses].slice(0, 5).join(', ')}`
    );
  }

  if (foundUrls.size === 0 && authenticatedHits > 0) {
    notes.push('Stayed authenticated on at least one account route but found zero recipe references — the deliveries/order-history UI or its API likely uses a shape this script does not yet recognize. Check the "[ichikawa] JSON endpoint seen" lines above for the real endpoints and adapt collectRecipeRefs()/CANDIDATE_PATHS.');
  }

  if (foundUrls.size > 0) {
    notes.push('Could not always cleanly distinguish "ordered/delivered" from merely "browsed/recommended" recipes when the source was a generic JSON endpoint rather than a clearly-scoped deliveries page — treat this list as a best-effort past-box set, not a guaranteed-exact one.');
  }

  const urls = [...foundUrls].sort();
  const header = `# box-history-urls.txt — generated ${new Date().toISOString()} — ${urls.length} recipe URL(s)\n`;
  fs.writeFileSync(URLS_OUT_FILE, header + urls.join('\n') + (urls.length ? '\n' : ''));
  console.error(`[ichikawa] Wrote ${urls.length} URL(s) to ${URLS_OUT_FILE}`);

  await context.close();
  await browser.close();

  console.log(JSON.stringify({ count: urls.length, urls, notes }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[ichikawa] Fatal error:', err);
  process.exit(1);
});

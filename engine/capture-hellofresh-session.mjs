/**
 * @vibe-author STLE @version 4 @date 05JUL26 @comment creds file now OPTIONAL — missing/blank → manual login in the visible window, no plaintext-password file required
 * @vibe-author STLE @version 3 @date 05JUL26 @comment genuine-auth gate (probe /my-deliveries for logout affordance, reject 404/Inloggen body) — v2 heuristic false-positived on cf-only cookies
 * @vibe-author STLE @version 2 @date 05JUL26 @comment credential auto-login + auto login-detection, no stdin (manual ENTER handshake was failing)
 * @vibe-author STLE @version 1 @date 05JUL26 @comment one-time manual HelloFresh login capture (Datadome-safe)
 *
 * capture-hellofresh-session.mjs
 *
 * HelloFresh Belgium (hellofresh.be) sits behind Datadome bot-protection. This script
 * pops a real, visible browser window, auto-fills credentials from a local creds file,
 * submits the login form, then POLLS for login-success signals (no stdin/readline —
 * the human never has to touch this terminal). If a bot-check / extra verification step
 * appears, the human can solve it right in the visible window and the script notices
 * success and finishes on its own.
 *
 * Uses launchPersistentContext with a userDataDir (not a throwaway context) so the
 * profile itself stays logged in across runs too — belt and braces alongside the
 * exported storageState file.
 *
 * Credentials (OPTIONAL): data/.hf-creds.json → { "email": "...", "password": "..." }
 * If present + valid, the script auto-fills the login as a convenience. If missing or blank,
 * it skips auto-fill and you log in fully by hand in the visible window — no plaintext-password
 * file required. (gitignored when present — never commit; never printed to any log.)
 *
 * Run: node engine/capture-hellofresh-session.mjs   (or: npm run capture)
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Anchor data/ at the repo root regardless of cwd (one level up from this engine/ file's dir).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data');
const PROFILE_DIR = path.join(OUT_DIR, '.hf-browser-profile');
const SESSION_FILE = path.join(OUT_DIR, '.hf-session.json');
const CREDS_FILE = path.join(OUT_DIR, '.hf-creds.json');

// A normal-looking desktop UA — the default headless-chromium UA is a Datadome tell.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const LOGIN_POLL_TOTAL_MS = 300_000; // patient window — human may need email/SMS code or a challenge
const LOGIN_POLL_INTERVAL_MS = 3_000;
const CHALLENGE_WARN_AFTER_MS = 10_000;

/**
 * Load optional credentials for the convenience auto-fill. Returns { email, password }
 * when the file exists and both fields are non-empty; otherwise returns null so the caller
 * falls back to manual login in the visible window. Never exits — creds are optional.
 */
function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch (err) {
    console.error(`[ichikawa] Could not parse ${CREDS_FILE} as JSON (${err.message}) — will use manual login.`);
    return null;
  }

  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  const password = typeof parsed.password === 'string' ? parsed.password : '';

  if (!email || !password) {
    return null;
  }

  return { email, password };
}

/** Best-effort dismiss of a OneTrust-style cookie/consent banner. Never fatal. */
async function dismissConsentBanner(page) {
  try {
    const oneTrustBtn = page.locator('#onetrust-accept-btn-handler');
    if (await oneTrustBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await oneTrustBtn.click({ timeout: 3000 });
      console.error('[ichikawa] Dismissed consent banner (OneTrust id).');
      return;
    }
  } catch {
    // ignore — fall through to the text-based attempt
  }

  try {
    const textBtn = page.getByRole('button', { name: /accepteren|accepteer|accept|akkoord/i });
    if (await textBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await textBtn.first().click({ timeout: 3000 });
      console.error('[ichikawa] Dismissed consent banner (text match).');
    }
  } catch {
    // absence of a consent banner is normal — never fail the run over this
  }
}

/** Locate the email/username input using a few resilient strategies. */
async function findEmailField(page) {
  const candidates = [
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[id*="email" i]'),
    page.locator('input[name*="username" i]'),
    page.locator('input[id*="username" i]'),
    page.getByLabel(/e-?mail/i),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        return locator.first();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Locate the password input. */
async function findPasswordField(page) {
  const candidates = [
    page.locator('input[type="password"]'),
    page.getByLabel(/wachtwoord|password/i),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        return locator.first();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Locate and click a submit/login button; falls back to Enter in the password field. */
async function submitLoginForm(page, passwordField) {
  const candidates = [
    page.locator('button[type="submit"]'),
    page.getByRole('button', { name: /inloggen|log in|aanmelden|sign in/i }),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await locator.first().click({ timeout: 5000 });
        return true;
      }
    } catch {
      // try next candidate
    }
  }

  // Fallback: press Enter in the password field to submit the form.
  if (passwordField) {
    try {
      await passwordField.press('Enter');
      return true;
    } catch {
      // fall through to false
    }
  }
  return false;
}

/**
 * Probe a single account route and decide whether it proves genuine authentication.
 * Returns 'authed' | 'unauthed' | 'notfound' (404 body — caller should try the next route).
 *
 * A route proves auth ONLY IF the body is NOT a 404 AND a logout affordance is present,
 * AND there is NO primary "Inloggen"/"Log in" auth link. HelloFresh silently 200s a
 * "pagina niet gevonden" body for unauthenticated account routes (no redirect to /login),
 * so URL/redirect checks are worthless — we must inspect the rendered page.
 */
async function probeAuthRoute(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    return 'unauthed';
  }
  // Let client-rendered content settle a moment.
  await page.waitForTimeout(1500);

  // 404 / not-found body — HelloFresh serves this (200) for unauthed account routes.
  try {
    const notFound = page.getByText(/pagina niet gevonden|page not found|404/i);
    if (await notFound.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      return 'notfound';
    }
  } catch {
    // ignore — treat as "keep checking"
  }

  // A logout affordance is the strongest positive signal.
  let hasLogout = false;
  try {
    const logout = page.locator('a[href*="/logout" i]');
    if (await logout.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      hasLogout = true;
    }
    if (!hasLogout) {
      const logoutText = page.getByText(/uitloggen|log ?out|sign ?out/i);
      if (await logoutText.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        hasLogout = true;
      }
    }
  } catch {
    // ignore
  }

  // A primary "Inloggen"/"Log in" link means we are NOT authenticated.
  let hasLoginLink = false;
  try {
    const loginLink = page.locator('a[href*="/login" i]');
    if (await loginLink.first().isVisible({ timeout: 800 }).catch(() => false)) {
      hasLoginLink = true;
    }
    if (!hasLoginLink) {
      const loginText = page.getByRole('link', { name: /inloggen|log ?in|sign ?in/i });
      if (await loginText.first().isVisible({ timeout: 800 }).catch(() => false)) {
        hasLoginLink = true;
      }
    }
  } catch {
    // ignore
  }

  // Authenticated only if a logout affordance exists and no login link is the primary auth action.
  if (hasLogout && !hasLoginLink) {
    return 'authed';
  }
  return 'unauthed';
}

/**
 * Genuine-auth check: actively load account routes and verify a real logged-in signal.
 * Only returns true when a route proves authentication (see probeAuthRoute). Never trusts
 * cf-only cookies or a mere "left /login" URL.
 */
async function isGenuinelyAuthenticated(page) {
  const routes = [
    'https://www.hellofresh.be/my-deliveries',
    'https://www.hellofresh.be/my-account',
  ];
  for (const url of routes) {
    const result = await probeAuthRoute(page, url);
    if (result === 'authed') return true;
    // 'notfound' → this route 404'd; try the next. 'unauthed' → also try the next as a fallback.
  }
  return false;
}

async function main() {
  const creds = loadCreds(); // null → manual login in the visible window

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  if (creds) {
    console.error(`[ichikawa] Creds file found — will auto-fill login as ${creds.email}`);
  } else {
    console.error("[ichikawa] No creds file found — log in manually in the browser window; I'll watch and save once you're genuinely logged in.");
  }
  console.error('[ichikawa] Launching browser window...');

  // launchPersistentContext gives us the context directly (no separate browser handle),
  // and keeps the profile logged in on disk across future runs.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
  });

  const page = context.pages()[0] ?? (await context.newPage());

  // Save the session ONLY when genuine auth is confirmed.
  const saveAuthedAndExit = async () => {
    const cookies = await context.cookies().catch(() => []);
    const hfCookies = cookies.filter((c) => /hellofresh/i.test(c.domain));
    await context.storageState({ path: SESSION_FILE }).catch((err) => {
      console.error(`[ichikawa] Failed to write session file: ${err.message}`);
    });
    console.error(`[ichikawa] Session saved to: ${SESSION_FILE}`);
    console.error(`[ichikawa] Captured ${hfCookies.length} hellofresh cookie(s).`);
    console.error('[ichikawa] A real authentication signal was confirmed (logout affordance on an account route).');
    console.error(`[ichikawa] Persistent browser profile kept at: ${PROFILE_DIR}`);
    await context.close();
    process.exit(0);
  };

  // Timeout path: do NOT overwrite any existing session with an unverified one.
  const failWithoutSaving = async () => {
    console.error('[ichikawa] Genuine authentication was never confirmed — NOT saving a session file.');
    if (fs.existsSync(SESSION_FILE)) {
      console.error(`[ichikawa] Existing session file left untouched: ${SESSION_FILE}`);
    }
    console.error('[ichikawa] Check: are the account credentials correct? Did you complete any');
    console.error('[ichikawa] email/SMS code, multi-step form, or bot-check in the browser window?');
    console.error(`[ichikawa] Persistent browser profile kept at: ${PROFILE_DIR}`);
    await context.close();
    process.exit(1);
  };

  console.error('[ichikawa] Navigating to login page...');
  try {
    await page.goto('https://www.hellofresh.be/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.error(`[ichikawa] Could not reach /login directly (${err.message}), falling back to homepage.`);
    await page.goto('https://www.hellofresh.be/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[ichikawa] Looking for a login/inloggen link on the homepage...');
    try {
      const loginLink = page.getByRole('link', { name: /inloggen|log in|sign in/i });
      if (await loginLink.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await loginLink.first().click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    } catch (err2) {
      console.error(`[ichikawa] No login link found on homepage (${err2.message}); continuing anyway.`);
    }
  }

  console.error('[ichikawa] Checking for a cookie/consent banner...');
  await dismissConsentBanner(page);

  if (creds) {
    // Convenience auto-fill + submit. If it misses, the human finishes in the visible window.
    console.error('[ichikawa] Filling credentials...');
    const emailField = await findEmailField(page);
    const passwordField = await findPasswordField(page);

    if (!emailField || !passwordField) {
      console.error('[ichikawa] WARNING: could not locate the email and/or password field on the page.');
      console.error('[ichikawa] The page markup may differ from what this script expects — you may need');
      console.error('[ichikawa] to log in manually in the open window. Will keep watching for success.');
    } else {
      try {
        await emailField.fill(creds.email);
        await passwordField.fill(creds.password);
      } catch (err) {
        console.error(`[ichikawa] Failed to fill the login form: ${err.message}`);
        console.error('[ichikawa] You may need to fill it manually in the open window.');
      }
    }

    console.error('[ichikawa] Submitting login form...');
    const submitted = await submitLoginForm(page, passwordField);
    if (!submitted) {
      console.error('[ichikawa] Could not find a submit control — press Enter/click login manually if needed.');
    }
  } else {
    console.error('[ichikawa] Manual-login mode — waiting for you to log in in the browser window.');
  }

  console.error('[ichikawa] Verifying genuine authentication (probing account routes, no keypress needed)...');

  const start = Date.now();
  let warnedAboutChallenge = false;
  while (Date.now() - start < LOGIN_POLL_TOTAL_MS) {
    if (await isGenuinelyAuthenticated(page)) {
      console.error('[ichikawa] Genuine login confirmed.');
      await saveAuthedAndExit();
      return;
    }

    if (!warnedAboutChallenge && Date.now() - start > CHALLENGE_WARN_AFTER_MS) {
      warnedAboutChallenge = true;
      console.error('');
      console.error('[ichikawa] Complete the login in the open browser window — it may be a multi-step');
      console.error('[ichikawa] form, may need an email/SMS code, or a bot-check. I will keep watching and');
      console.error('[ichikawa] only save once you are GENUINELY logged in.');
      console.error('');
    }

    await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
  }

  console.error('');
  console.error('[ichikawa] Timed out — genuine authentication was never confirmed.');
  console.error('');
  await failWithoutSaving();
}

main().catch(async (err) => {
  console.error('[ichikawa] Fatal error:', err);
  process.exit(1);
});

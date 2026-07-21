/**
 * @vibe-author STLE @version 1 @date 05JUL26 @comment normalize HelloFresh recipe detail pages -> corpus JSON via schema.org JSON-LD
 *
 * enrich-recipes.mjs
 *
 * HelloFresh recipe DETAIL pages are public (no auth) and carry schema.org JSON-LD
 * (@type "Recipe"). This tool fetches each page, extracts the Recipe node, normalizes
 * it into the Ichikawa corpus shape, and writes data/recipes/<id>.json.
 *
 * Plain HTTPS fetch is tried first (fast, no browser). If that yields no Recipe JSON-LD
 * (JS-rendered or Datadome-challenged page), falls back to a headless chromium page,
 * reusing the saved HelloFresh session (.hf-session.json) as storageState if present.
 *
 * Run:
 *   node engine/enrich-recipes.mjs <url> [<url2> ...]     (or: npm run enrich -- <url>)
 *   node engine/enrich-recipes.mjs --file urls.txt
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  BROWSER_UA,
  extractJsonLdNodesFromHtml,
  extractJsonLdNodesFromScriptTexts,
  findRecipeNode,
  normalizeRecipe,
  mergeWithExisting,
} from './lib-recipe.mjs';

// Anchor data/ at the repo root regardless of cwd (one level up from this engine/ file's dir).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data');
const RECIPES_DIR = path.join(OUT_DIR, 'recipes');
const SESSION_FILE = path.join(OUT_DIR, '.hf-session.json');

// ---------------------------------------------------------------------------
// Arg parsing: URLs from argv and/or --file <path> (one URL per line, # comments ok)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let filePath = null;
  const urls = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      filePath = argv[++i];
    } else if (a.startsWith('--file=')) {
      filePath = a.slice('--file='.length);
    } else {
      urls.push(a);
    }
  }
  if (filePath) {
    const content = fs.readFileSync(path.resolve(filePath), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      urls.push(trimmed);
    }
  }
  return [...new Set(urls)];
}

function loadExisting(outPath) {
  try {
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetching: plain HTTPS first (fast, public pages need no browser), browser fallback
// ---------------------------------------------------------------------------
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

async function fetchViaPlainHttp(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return extractJsonLdNodesFromHtml(html);
}

async function fetchViaBrowser(url) {
  const browser = await getBrowser();
  const storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
  const context = await browser.newContext({ userAgent: BROWSER_UA, storageState });
  try {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // networkidle can time out on heavy pages — proceed with whatever loaded
    }
    const scriptTexts = await page.$$eval('script[type="application/ld+json"]', (els) =>
      els.map((e) => e.textContent || '')
    );
    return extractJsonLdNodesFromScriptTexts(scriptTexts);
  } finally {
    await context.close();
  }
}

async function processUrl(url) {
  let nodes = [];
  let via = 'fetch';
  try {
    nodes = await fetchViaPlainHttp(url);
  } catch (err) {
    console.error(`[ichikawa] ${url} — plain fetch failed (${err.message}), trying browser fallback`);
  }

  let recipeNode = findRecipeNode(nodes);
  if (!recipeNode) {
    via = 'browser';
    console.error(`[ichikawa] ${url} — no Recipe JSON-LD via plain fetch, falling back to headless browser`);
    nodes = await fetchViaBrowser(url);
    recipeNode = findRecipeNode(nodes);
  }

  if (!recipeNode) {
    throw new Error('no Recipe JSON-LD found (plain fetch + browser fallback both came up empty)');
  }

  const fresh = normalizeRecipe(recipeNode, url, { source: 'hellofresh' });
  const outPath = path.join(RECIPES_DIR, `${fresh.id}.json`);
  const existing = loadExisting(outPath);
  const merged = mergeWithExisting(fresh, existing);

  fs.mkdirSync(RECIPES_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');

  console.error(`[ichikawa] ${url} — OK (${via}) -> ${merged.id}.json`);
  return merged.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const urls = parseArgs(process.argv.slice(2));
  if (urls.length === 0) {
    console.error('Usage:');
    console.error('  node enrich-recipes.mjs <url> [<url2> ...]');
    console.error('  node enrich-recipes.mjs --file urls.txt');
    process.exit(1);
  }

  const ok = [];
  const failed = [];

  for (const url of urls) {
    try {
      const id = await processUrl(url);
      ok.push(id);
    } catch (err) {
      console.error(`[ichikawa] ${url} — FAILED: ${err.message}`);
      failed.push({ url, reason: err.message });
    }
  }

  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }

  console.log(JSON.stringify({ ok, failed }, null, 2));
  process.exit(failed.length > 0 && ok.length === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[ichikawa] Fatal error:', err);
  process.exit(1);
});

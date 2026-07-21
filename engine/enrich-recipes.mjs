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
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { cleanText } from './lib-clean.mjs';

// Anchor data/ at the repo root regardless of cwd (one level up from this engine/ file's dir).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data');
const RECIPES_DIR = path.join(OUT_DIR, 'recipes');
const SESSION_FILE = path.join(OUT_DIR, '.hf-session.json');

// Browser-like UA for both the plain fetch and the headless-browser fallback.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

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

// ---------------------------------------------------------------------------
// ISO-8601 duration ("PT45M", "PT1H10M") -> integer minutes
// ---------------------------------------------------------------------------
function isoDurationToMinutes(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (!d && !h && !min && !s) return null; // matched shape but nothing captured
  const total = Number(d || 0) * 24 * 60 + Number(h || 0) * 60 + Number(min || 0) + Number(s || 0) / 60;
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// JSON-LD extraction + flattening (handles plain object / array / @graph)
// ---------------------------------------------------------------------------
function flattenJsonLd(parsed) {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenJsonLd);
  if (parsed && Array.isArray(parsed['@graph'])) return parsed['@graph'].flatMap(flattenJsonLd);
  return [parsed];
}

function extractJsonLdNodesFromHtml(html) {
  const nodes = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      nodes.push(...flattenJsonLd(JSON.parse(raw)));
    } catch {
      // malformed JSON-LD block — skip it, don't abort the whole page
    }
  }
  return nodes;
}

function extractJsonLdNodesFromScriptTexts(texts) {
  const nodes = [];
  for (const raw of texts) {
    if (!raw || !raw.trim()) continue;
    try {
      nodes.push(...flattenJsonLd(JSON.parse(raw)));
    } catch {
      // malformed JSON-LD block — skip it
    }
  }
  return nodes;
}

function findRecipeNode(nodes) {
  return (
    nodes.find((n) => {
      if (!n || !n['@type']) return false;
      const t = n['@type'];
      return Array.isArray(t) ? t.some((x) => /recipe/i.test(String(x))) : /recipe/i.test(String(t));
    }) || null
  );
}

// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------
function slugify(s) {
  return (
    String(s || 'recipe')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics left behind by NFKD (e.g. accented chars)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'recipe'
  );
}

function sanitizeId(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// id: prefer JSON-LD identifier, else the hex-id suffix on the URL slug, else slugify(title)
function deriveId(urlStr, node, title) {
  const identifier = node?.identifier || node?.recipeId;
  if (identifier && typeof identifier === 'string' && identifier.trim()) {
    return sanitizeId(identifier.trim());
  }
  try {
    const u = new URL(urlStr);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    // HelloFresh recipe slugs look like "creamy-garlic-chicken-5f8a1b2c3d4e5f6a7b8c9d0e"
    if (/-[a-f0-9]{6,}$/i.test(last)) return sanitizeId(last);
  } catch {
    // invalid URL — fall through to title slug
  }
  return slugify(title);
}

function parseServings(recipeYield) {
  if (recipeYield == null) return null;
  const val = Array.isArray(recipeYield) ? recipeYield[0] : recipeYield;
  const m = String(val).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Best-effort split of a raw ingredient string into { name, qty, unit }.
// Handles whole numbers, decimals, simple fractions ("1/2") and mixed fractions ("1 1/2").
// Falls back to putting the whole string in `name` when nothing safely parses out.
function parseIngredient(raw) {
  const str = String(raw).trim();
  const m = str.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*([a-zA-Z]+)?\s*(.*)$/);
  if (!m || !m[1]) {
    return { name: str, qty: null, unit: null };
  }
  const qtyText = m[1];
  let qty;
  if (qtyText.includes(' ')) {
    const [whole, frac] = qtyText.split(' ');
    const [n, d] = frac.split('/').map(Number);
    qty = Number(whole) + (d ? n / d : 0);
  } else if (qtyText.includes('/')) {
    const [n, d] = qtyText.split('/').map(Number);
    qty = d ? n / d : Number(n);
  } else {
    qty = Number(qtyText);
  }
  const unit = m[2] ? m[2].toLowerCase() : null;
  const name = (m[3] || '').trim();
  if (!name) {
    // The optional unit group swallowed the whole remainder (e.g. "2 Eggs") — safer to
    // bail out to the raw string than guess wrong about qty/unit/name boundaries.
    return { name: str, qty: null, unit: null };
  }
  return { name, qty: Number.isFinite(qty) ? qty : null, unit };
}

function extractIngredients(node) {
  const raw = node.recipeIngredient || node.ingredients || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map(parseIngredient)
    .map((i) => ({ ...i, name: i.name != null ? cleanText(i.name) : i.name }));
}

// recipeInstructions can be a plain string, an array of strings, an array of HowToStep
// objects, or HowToSection objects wrapping their own itemListElement steps.
function extractSteps(instr) {
  if (!instr) return [];
  const arr = Array.isArray(instr) ? instr : [instr];
  const steps = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) steps.push({ text, minutes: null, mode: null });
    } else if (item && typeof item === 'object') {
      if (item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
        for (const sub of item.itemListElement) {
          const text = (typeof sub === 'string' ? sub : sub.text || sub.name || '').trim();
          if (text) steps.push({ text, minutes: null, mode: null });
        }
      } else {
        const text = (item.text || item.name || '').trim();
        if (text) steps.push({ text, minutes: null, mode: null });
      }
    }
  }
  // Flatten HelloFresh's embedded HTML/entities in each step to readable plain text.
  return steps.map((s) => ({ ...s, text: cleanText(s.text) })).filter((s) => s.text);
}

function extractImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return extractImage(img[0]);
  if (typeof img === 'string') return img;
  if (typeof img === 'object') return img.url || img['@id'] || null;
  return null;
}

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRecipe(node, url) {
  const title = cleanText(node.name || 'Untitled Recipe');
  const totalTime =
    isoDurationToMinutes(node.totalTime) ??
    (() => {
      const cook = isoDurationToMinutes(node.cookTime);
      const prep = isoDurationToMinutes(node.prepTime);
      if (cook == null && prep == null) return null;
      return (cook || 0) + (prep || 0);
    })();

  const tags = [...new Set([...toArray(node.keywords), ...toArray(node.recipeCategory)])];
  const cuisineArr = toArray(node.recipeCuisine);
  const cuisine = cuisineArr.length ? cuisineArr.join(', ') : null;

  return {
    id: deriveId(url, node, title),
    source: 'hellofresh',
    title,
    subtitle: node.description ? cleanText(String(node.description)) : null,
    servings: parseServings(node.recipeYield),
    ingredients: extractIngredients(node),
    steps: extractSteps(node.recipeInstructions),
    totalTime,
    activeTime: null, // derived later by a manual/LLM timing pass
    tags,
    cuisine,
    prepTime: isoDurationToMinutes(node.prepTime),
    image: extractImage(node.image),
    nutrition: node.nutrition || null,
    sourceUrl: url,
    addedDate: new Date().toISOString(),
    keep: true,
  };
}

// Preserve fields that a later human/LLM pass owns, and (as a courtesy beyond the spec)
// the original addedDate — a re-enrich is a refresh, not a fresh "add".
function mergeWithExisting(fresh, existing) {
  if (!existing) return fresh;
  const merged = { ...fresh };
  merged.keep = existing.keep ?? true;
  merged.activeTime = existing.activeTime ?? null;
  if (existing.addedDate) merged.addedDate = existing.addedDate;
  if (Array.isArray(existing.steps) && Array.isArray(merged.steps)) {
    merged.steps = merged.steps.map((s, i) => ({
      text: s.text,
      minutes: existing.steps[i]?.minutes ?? null,
      mode: existing.steps[i]?.mode ?? null,
    }));
  }
  return merged;
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

export async function processUrl(url) {
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

  const fresh = normalizeRecipe(recipeNode, url);
  const outPath = path.join(RECIPES_DIR, `${fresh.id}.json`);
  const existing = loadExisting(outPath);
  const merged = mergeWithExisting(fresh, existing);

  fs.mkdirSync(RECIPES_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');

  console.error(`[ichikawa] ${url} — OK (${via}) -> ${merged.id}.json`);
  return merged;
}

// Close the shared headless browser if it was ever launched (fallback path). A
// long-running host (the server) can call this to release it between bursts;
// getBrowser() lazily relaunches on the next fallback.
export async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    const browser = await p;
    await browser.close();
  } catch {
    // already gone / never fully launched — nothing to release
  }
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
      const merged = await processUrl(url);
      ok.push(merged.id);
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

// Only run the CLI when invoked directly (`node engine/enrich-recipes.mjs …`);
// when imported (e.g. by the server's add-from-URL route) the exports above are
// used and main() stays dormant.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[ichikawa] Fatal error:', err);
    process.exit(1);
  });
}

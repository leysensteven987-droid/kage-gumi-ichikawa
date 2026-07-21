// Shared recipe-normalization library for Ichikawa.
//
// The pure "page HTML / script text -> corpus recipe JSON" logic, extracted out of
// enrich-recipes.mjs so it can be reused WITHOUT Playwright: the standalone Express
// server imports these to power POST /api/recipes/import (paste an HTML address, get
// a recipe), and the engine keeps using them for its batch HelloFresh enrich pass.
//
// Everything here is dependency-light (only cleanText from lib-clean.mjs) and has no
// filesystem / browser side effects, so it runs the same in the engine and the server.

import { cleanText } from './lib-clean.mjs';

// Browser-like UA for plain HTTPS fetches (public recipe pages need no browser).
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// ISO-8601 duration ("PT45M", "PT1H10M") -> integer minutes
// ---------------------------------------------------------------------------
export function isoDurationToMinutes(iso) {
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
export function flattenJsonLd(parsed) {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenJsonLd);
  if (parsed && Array.isArray(parsed['@graph'])) return parsed['@graph'].flatMap(flattenJsonLd);
  return [parsed];
}

export function extractJsonLdNodesFromHtml(html) {
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

export function extractJsonLdNodesFromScriptTexts(texts) {
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

export function findRecipeNode(nodes) {
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
export function slugify(s) {
  return (
    String(s || 'recipe')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics left behind by NFKD (e.g. accented chars)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'recipe'
  );
}

export function sanitizeId(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// id: prefer JSON-LD identifier, else the hex-id suffix on the URL slug, else slugify(title)
export function deriveId(urlStr, node, title) {
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
    // Any other site: fall back to the last path segment if it's a usable slug.
    if (last && !/\.[a-z0-9]+$/i.test(last)) {
      const s = sanitizeId(last);
      if (s) return s;
    }
  } catch {
    // invalid URL — fall through to title slug
  }
  return slugify(title);
}

// source: a short identifier for where the recipe came from, derived from the host
// ("www.hellofresh.be" -> "hellofresh", "www.ah.nl" -> "ah"). Falls back to "web".
export function deriveSource(urlStr) {
  try {
    const host = new URL(urlStr).hostname.replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    // Drop the TLD, take the most specific remaining label (the brand).
    const brand = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return sanitizeId(brand) || 'web';
  } catch {
    return 'web';
  }
}

export function parseServings(recipeYield) {
  if (recipeYield == null) return null;
  const val = Array.isArray(recipeYield) ? recipeYield[0] : recipeYield;
  const m = String(val).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Best-effort split of a raw ingredient string into { name, qty, unit }.
// Handles whole numbers, decimals, simple fractions ("1/2") and mixed fractions ("1 1/2").
// Falls back to putting the whole string in `name` when nothing safely parses out.
export function parseIngredient(raw) {
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

export function extractIngredients(node) {
  const raw = node.recipeIngredient || node.ingredients || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map(parseIngredient)
    .map((i) => ({ ...i, name: i.name != null ? cleanText(i.name) : i.name }));
}

// recipeInstructions can be a plain string, an array of strings, an array of HowToStep
// objects, or HowToSection objects wrapping their own itemListElement steps.
export function extractSteps(instr) {
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
  // Flatten embedded HTML/entities in each step to readable plain text.
  return steps.map((s) => ({ ...s, text: cleanText(s.text) })).filter((s) => s.text);
}

export function extractImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return extractImage(img[0]);
  if (typeof img === 'string') return img;
  if (typeof img === 'object') return img.url || img['@id'] || null;
  return null;
}

export function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Normalize a schema.org Recipe node into the Ichikawa corpus shape.
// `opts.source` overrides the source label (the engine pins "hellofresh"); when omitted
// the source is derived from the URL host so a generic web import is still labelled.
// `opts.now` lets a caller inject a deterministic addedDate (defaults to now).
export function normalizeRecipe(node, url, opts = {}) {
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
    source: opts.source || deriveSource(url),
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
    addedDate: opts.now || new Date().toISOString(),
    keep: true,
  };
}

// Preserve fields that a later human/LLM pass owns, and (as a courtesy beyond the spec)
// the original addedDate — a re-import is a refresh, not a fresh "add".
export function mergeWithExisting(fresh, existing) {
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

// One-shot: raw page HTML -> normalized corpus recipe (or null if no Recipe JSON-LD).
export function recipeFromHtml(html, url, opts = {}) {
  const node = findRecipeNode(extractJsonLdNodesFromHtml(html));
  return node ? normalizeRecipe(node, url, opts) : null;
}

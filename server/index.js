// Ichikawa — standalone Express server.
//
// Serves the built kawaii-bento UI (dist/) and the recipe API. Forked out of
// kage-gumi's frontend/server/index.js (the loadIchikawaRecipes loader + the two
// recipe routes), rebuilt to stand on its own with no KG runtime around it.
//
// Data layout (repo-root relative, resolved from import.meta.url so cwd doesn't matter):
//   data/recipes/            — personal corpus, one JSON per recipe OR a {recipes:[...]} bundle (gitignored)
//   data/recipes.sample.json — committed seed fallback ({recipes:[...]} or a bare array)
//
// Never a 500 on missing data: a missing corpus dir/file degrades to the seed, a
// missing seed degrades to an empty list.

import express from "express";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { processUrl } from "../engine/enrich-recipes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const SEED_FILE = path.join(DATA_DIR, "recipes.sample.json");
const DIST_DIR = path.join(REPO_ROOT, "dist");

// Load the recipe corpus, falling back to the committed seed, then to empty.
// Reports which source answered so the UI/logs can tell live corpus from seed.
function loadIchikawaRecipes() {
  const recipes = [];
  // 1) personal corpus (gitignored) — one JSON per recipe (or a {recipes:[...]} bundle)
  try {
    for (const e of readdirSync(RECIPES_DIR, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(RECIPES_DIR, e.name), "utf8"));
        if (Array.isArray(r?.recipes)) recipes.push(...r.recipes);
        else if (r && r.id) recipes.push(r);
      } catch {}
    }
  } catch {}
  // Soft-removed recipes (keep:false, set via POST .../remove) stay excluded so a cull
  // persists across reloads. Seed recipes / anything without a keep field are kept.
  if (recipes.length) return { recipes: recipes.filter((r) => r.keep !== false), source: "corpus" };
  // 2) committed seed fallback (may be {recipes:[...]} or a bare array)
  try {
    const seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));
    const arr = Array.isArray(seed?.recipes) ? seed.recipes : Array.isArray(seed) ? seed : [];
    return { recipes: arr.filter((r) => r.keep !== false), source: "seed" };
  } catch {}
  return { recipes: [], source: "empty" };
}

// Coerce a client-supplied ingredient list into clean, safe records before it
// touches disk. Blank-name rows are dropped, qty becomes a finite number or null,
// name/unit are trimmed strings. Returns null when the payload isn't an array, or
// an array (possibly empty) of {name, qty, unit}. Bounded so a bad/huge payload
// can't bloat a corpus file.
const MAX_INGREDIENTS = 100;
const MAX_FIELD = 120;
function sanitizeIngredients(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const it of input.slice(0, MAX_INGREDIENTS)) {
    if (!it || typeof it !== "object") continue;
    const name = String(it.name ?? "").trim().slice(0, MAX_FIELD);
    if (!name) continue; // an ingredient with no name is meaningless — skip it
    const unit = String(it.unit ?? "").trim().slice(0, MAX_FIELD);
    let qty = it.qty;
    if (qty === "" || qty == null) qty = null;
    else { qty = Number(qty); if (!Number.isFinite(qty)) qty = null; }
    out.push({ name, qty, unit });
  }
  return out;
}

const app = express();
app.use(express.json());

app.get("/api/recipes", (_req, res) => {
  const { recipes, source } = loadIchikawaRecipes();
  res.json({ recipes, source, count: recipes.length });
});

// Add from URL: fetch a public recipe page (schema.org JSON-LD), normalize it into
// the corpus shape, and write data/recipes/<id>.json — the same pipeline the
// `npm run enrich` engine uses, exposed so the app (phone included) can add a recipe
// without the command line. Returns the normalized recipe so the UI can show it at once.
app.post("/api/recipes/add", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) return res.status(400).json({ error: "geef een recept-URL op" });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "dat lijkt geen geldige URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "alleen http(s)-links kunnen worden toegevoegd" });
  }
  try {
    // Bound the whole fetch+render so a slow/blocking site fails with a message
    // instead of hanging the request until the browser/tunnel drops it ("Load failed").
    const recipe = await Promise.race([
      processUrl(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("__timeout__")), 55000)),
    ]);
    return res.json({ ok: true, recipe });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[ichikawa] add-from-URL failed for ${url}:`, msg);
    if (msg === "__timeout__") {
      return res.status(504).json({ error: "de pagina duurde te lang om te laden — probeer 't opnieuw" });
    }
    // No recipe markup, network/Datadome block, etc. — gentle human message; the
    // technical reason stays in the server log above.
    return res.status(422).json({ error: "geen recept gevonden op die pagina" });
  }
});

// Soft-remove: sets keep:false on the recipe's own corpus file (never deletes it, never
// touches the seed) so the cull is reversible — just edit the file back to keep:true.
app.post("/api/recipes/:id/remove", (req, res) => {
  const id = req.params.id;
  if (!id || /[\\/]/.test(id) || id.includes("..")) return res.status(400).json({ error: "invalid id" });
  const file = path.join(RECIPES_DIR, `${id}.json`);
  if (!existsSync(file)) return res.status(404).json({ error: "recipe not found" });
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    r.keep = false;
    writeFileSync(file, JSON.stringify(r, null, 2));
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "failed to remove recipe" });
  }
});

// Edit a recipe's ingredient list (swap one out, change a quantity, add a new
// line). Writes to the recipe's OWN corpus file, never the seed.
//
// Seed recipes have no corpus file yet, so the first edit is copy-on-write: the
// whole currently-served set is materialized into data/recipes/ (the loader flips
// to corpus-only the moment any file exists, so writing just one would hide the
// rest of the seed). After that, every recipe is a normal editable corpus file.
app.put("/api/recipes/:id/ingredients", (req, res) => {
  const id = req.params.id;
  if (!id || /[\\/]/.test(id) || id.includes("..")) return res.status(400).json({ error: "invalid id" });
  const ingredients = sanitizeIngredients(req.body?.ingredients);
  if (!ingredients) return res.status(400).json({ error: "invalid ingredients" });

  const safeId = (rid) => rid && !/[\\/]/.test(rid) && !rid.includes("..");
  const file = path.join(RECIPES_DIR, `${id}.json`);
  try {
    if (existsSync(file)) {
      const r = JSON.parse(readFileSync(file, "utf8"));
      r.ingredients = ingredients;
      writeFileSync(file, JSON.stringify(r, null, 2));
      return res.json({ ok: true, ingredients });
    }
    // No corpus file — the recipe lives only in the seed. Materialize the served
    // set (excludes soft-removed recipes already) so nothing disappears, applying
    // the edit to the target on the way out.
    const { recipes } = loadIchikawaRecipes();
    if (!recipes.some((r) => r.id === id)) return res.status(404).json({ error: "recipe not found" });
    mkdirSync(RECIPES_DIR, { recursive: true });
    for (const r of recipes) {
      if (!r || !safeId(r.id)) continue;
      const f = path.join(RECIPES_DIR, `${r.id}.json`);
      if (existsSync(f)) continue; // don't clobber a real corpus file
      writeFileSync(f, JSON.stringify(r.id === id ? { ...r, ingredients } : r, null, 2));
    }
    return res.json({ ok: true, ingredients });
  } catch {
    return res.status(500).json({ error: "failed to save ingredients" });
  }
});

// Serve the built UI. Static assets first, then SPA fallback to index.html for any
// non-/api route so client-side routing / deep links resolve.
app.use(express.static(DIST_DIR));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  const indexFile = path.join(DIST_DIR, "index.html");
  if (existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(404).send("UI not built yet — run `npm run build`.");
});

const PORT = process.env.ICHIKAWA_PORT || 5273;
app.listen(PORT, () => {
  console.log(`Ichikawa 市川 — Market Scout listening on http://localhost:${PORT}`);
});

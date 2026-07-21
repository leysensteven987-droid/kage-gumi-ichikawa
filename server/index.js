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
import {
  BROWSER_UA,
  findRecipeNode,
  extractJsonLdNodesFromHtml,
  normalizeRecipe,
  mergeWithExisting,
} from "../engine/lib-recipe.mjs";

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

const app = express();
app.use(express.json());

app.get("/api/recipes", (_req, res) => {
  const { recipes, source } = loadIchikawaRecipes();
  res.json({ recipes, source, count: recipes.length });
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

// Import a recipe from any HTML address: fetch the page, pull its schema.org
// Recipe JSON-LD, normalize it into the corpus shape, and write it to
// data/recipes/<id>.json (creating the corpus dir if it's a fresh checkout).
// Re-importing the same recipe refreshes it in place, preserving human-owned
// fields (keep, step timings, original addedDate) via mergeWithExisting.
//
// Server-side plain fetch only (no headless browser): public recipe pages carry
// their JSON-LD in the initial HTML. Pages that hide it behind JS or a bot wall
// return a friendly 422 the UI can show — the batch `npm run enrich` engine keeps
// the browser fallback for HelloFresh's Datadome challenge.
app.post("/api/recipes/import", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Geef een geldige URL op." });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Alleen http(s)-adressen kunnen geïmporteerd worden." });
  }

  let html;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let r;
    try {
      r = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return res.status(422).json({ error: `De pagina gaf HTTP ${r.status} terug.` });
    html = await r.text();
  } catch (err) {
    const msg = err?.name === "AbortError" ? "De pagina reageerde te traag." : "De pagina kon niet opgehaald worden.";
    return res.status(422).json({ error: msg });
  }

  const node = findRecipeNode(extractJsonLdNodesFromHtml(html));
  if (!node) {
    return res.status(422).json({ error: "Geen recept gevonden op deze pagina (geen recept-data ingebed)." });
  }

  let recipe;
  try {
    const fresh = normalizeRecipe(node, url);
    if (!fresh.id) return res.status(422).json({ error: "Kon geen recept-id afleiden." });
    const file = path.join(RECIPES_DIR, `${fresh.id}.json`);
    let existing = null;
    try { existing = JSON.parse(readFileSync(file, "utf8")); } catch {}
    recipe = mergeWithExisting(fresh, existing);
    recipe.keep = true; // a fresh import always un-hides the card
    mkdirSync(RECIPES_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(recipe, null, 2) + "\n");
  } catch {
    return res.status(500).json({ error: "Kon het recept niet opslaan." });
  }

  return res.json({ ok: true, recipe });
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

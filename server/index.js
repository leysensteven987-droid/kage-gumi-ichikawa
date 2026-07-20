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
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

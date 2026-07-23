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
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { processUrl } from "../engine/enrich-recipes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
// Photo inbox: a phone snapshot of a cookbook page / recipe card parks here as
// <id>.<ext> + a <id>.json sidecar until a Claude Code session turns it into a
// real recipe under data/recipes/. Deliberately DUMB storage — the server never
// calls an AI/LLM, so there's no API key and no per-photo cost. Gitignored:
// these are personal photos.
const PHOTO_DIR = path.join(DATA_DIR, "photo-inbox");
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

// Coerce a client-supplied step list into clean records. Each step becomes
// {text, minutes, mode}: text trimmed (rows with empty text are dropped), minutes
// a finite non-negative number or null, mode "active" | "passive" (defaults active).
const MAX_STEPS = 60;
const MAX_STEP_TEXT = 1200;
function sanitizeSteps(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const s of input.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== "object") continue;
    const text = String(s.text ?? "").trim().slice(0, MAX_STEP_TEXT);
    if (!text) continue; // a step with no text is meaningless — skip it
    let minutes = s.minutes;
    if (minutes === "" || minutes == null) minutes = null;
    else { minutes = Number(minutes); minutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : null; }
    const mode = s.mode === "passive" ? "passive" : "active";
    out.push({ text, minutes, mode });
  }
  return out;
}

// A trimmed string, or undefined when the value isn't a string (so the caller can
// tell "absent / skip" from "set to empty").
function sanitizeStr(v) { return typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : undefined; }
// A finite non-negative number, or undefined (blank / bad → skip, never wipe).
function sanitizeNum(v) {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
// An array of trimmed non-empty tag strings, or undefined when not an array.
const MAX_TAGS = 40;
function sanitizeTags(v) {
  if (!Array.isArray(v)) return undefined;
  return v.map((t) => String(t ?? "").trim().slice(0, MAX_FIELD)).filter(Boolean).slice(0, MAX_TAGS);
}

// Build a partial patch from a PUT body: ONLY the editable fields actually present
// (and valid) end up in the returned object, so a merge never wipes a field the
// client didn't send.
function buildRecipePatch(body) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const k of ["title", "subtitle", "cuisine", "parallelTip"]) {
    if (k in body) { const s = sanitizeStr(body[k]); if (s !== undefined) patch[k] = s; }
  }
  for (const k of ["servings", "totalTime", "prepTime", "activeTime"]) {
    if (k in body) { const n = sanitizeNum(body[k]); if (n !== undefined) patch[k] = n; }
  }
  if ("tags" in body) { const t = sanitizeTags(body.tags); if (t !== undefined) patch.tags = t; }
  if ("ingredients" in body) { const ing = sanitizeIngredients(body.ingredients); if (ing) patch.ingredients = ing; }
  if ("steps" in body) { const st = sanitizeSteps(body.steps); if (st) patch.steps = st; }
  return patch;
}

// ─── Photo inbox helpers ────────────────────────────────────────────────────
// Only real camera-roll image types are accepted; the extension is DERIVED from
// the allow-listed mime, never from anything the client names, so a payload can
// never choose its own file extension.
const PHOTO_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // ~15 MB decoded — a phone photo, not a scan dump
const MAX_NOTE = 200;

// A short, single-line note ("kookboek p. 42"). Control characters stripped so a
// pasted note can't smuggle newlines/escapes into the sidecar.
function sanitizeNote(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NOTE);
}

// Sortable + filesystem-safe: millis prefix keeps newest-first trivial, the
// random suffix defuses same-millisecond collisions. No `/`, `\` or `..` by
// construction (both halves are [0-9a-z] plus the single separating dash).
function newPhotoId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Read every sidecar in the inbox, newest first. A missing dir is not an error —
// it just means nothing has been photographed yet.
function readPhotoInbox() {
  const items = [];
  try {
    for (const e of readdirSync(PHOTO_DIR, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".json")) continue;
      try {
        const it = JSON.parse(readFileSync(path.join(PHOTO_DIR, e.name), "utf8"));
        if (it && it.id && it.file) items.push(it);
      } catch {}
    }
  } catch {}
  return items.sort((a, b) => String(b.addedDate || "").localeCompare(String(a.addedDate || "")));
}

const app = express();
// Every route keeps the SMALL default body limit (~100kb) — except the photo
// upload, which brings its own 25mb parser. The global parser has to step aside
// for that one path, or it would 413 a phone photo before the route ever runs.
const PHOTO_UPLOAD_PATH = "/api/recipes/photo";
const jsonSmall = express.json();
app.use((req, res, next) => (req.path === PHOTO_UPLOAD_PATH ? next() : jsonSmall(req, res, next)));

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

// Full recipe edit: a partial patch of the editable fields (title, subtitle,
// cuisine, servings, totalTime, prepTime, activeTime, tags, parallelTip, steps,
// ingredients). Only the fields actually present in the body are overwritten —
// never wipes what the client didn't send. Same copy-on-write as /ingredients:
// a seed-only recipe first materializes the whole served set into RECIPES_DIR so
// the rest of the seed doesn't vanish when the loader flips to corpus-only.
app.put("/api/recipes/:id", (req, res) => {
  const id = req.params.id;
  if (!id || /[\\/]/.test(id) || id.includes("..")) return res.status(400).json({ error: "invalid id" });
  const patch = buildRecipePatch(req.body);
  if (!Object.keys(patch).length) return res.status(400).json({ error: "no editable fields" });

  const safeId = (rid) => rid && !/[\\/]/.test(rid) && !rid.includes("..");
  const file = path.join(RECIPES_DIR, `${id}.json`);
  try {
    if (existsSync(file)) {
      const r = JSON.parse(readFileSync(file, "utf8"));
      const merged = { ...r, ...patch };
      writeFileSync(file, JSON.stringify(merged, null, 2));
      return res.json({ ok: true, recipe: merged });
    }
    // No corpus file — the recipe lives only in the seed. Materialize the served
    // set (excludes soft-removed recipes already) so nothing disappears, applying
    // the patch to the target on the way out.
    const { recipes } = loadIchikawaRecipes();
    const target = recipes.find((r) => r.id === id);
    if (!target) return res.status(404).json({ error: "recipe not found" });
    const mergedTarget = { ...target, ...patch };
    mkdirSync(RECIPES_DIR, { recursive: true });
    for (const r of recipes) {
      if (!r || !safeId(r.id)) continue;
      const f = path.join(RECIPES_DIR, `${r.id}.json`);
      if (existsSync(f)) continue; // don't clobber a real corpus file
      writeFileSync(f, JSON.stringify(r.id === id ? mergedTarget : r, null, 2));
    }
    return res.json({ ok: true, recipe: mergedTarget });
  } catch {
    return res.status(500).json({ error: "failed to save recipe" });
  }
});

// ─── Photo inbox ─────────────────────────────────────────────────────────────
// Snap a cookbook page / recipe card on the phone; it is STORED, nothing more.
// No AI call happens here (no key, no cost) — a Claude Code session reads the
// pending photos later and writes real recipes into data/recipes/.
//
// The 25 MB body parser is mounted on THIS ROUTE ONLY; the global express.json()
// keeps its small default limit so a normal API route can't be flooded.
app.post(PHOTO_UPLOAD_PATH, express.json({ limit: "25mb" }), (req, res) => {
  const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(dataUrl.trim());
  if (!m) return res.status(400).json({ error: "geen geldige foto ontvangen" });
  const mime = m[1].toLowerCase();
  const ext = PHOTO_MIME_EXT[mime];
  if (!ext) return res.status(400).json({ error: "dat bestandstype kan ik niet bewaren — gebruik een foto (JPG, PNG, WEBP of HEIC)" });

  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return res.status(400).json({ error: "geen geldige foto ontvangen" });
  }
  if (!buf.length) return res.status(400).json({ error: "geen geldige foto ontvangen" });
  if (buf.length > MAX_PHOTO_BYTES) {
    return res.status(413).json({ error: "die foto is te groot (max 15 MB) — maak 'm wat kleiner" });
  }

  try {
    const id = newPhotoId();
    const item = {
      id,
      file: `${id}.${ext}`,
      mime,
      note: sanitizeNote(req.body?.note),
      addedDate: new Date().toISOString(),
      status: "pending",
    };
    mkdirSync(PHOTO_DIR, { recursive: true });
    writeFileSync(path.join(PHOTO_DIR, item.file), buf);
    writeFileSync(path.join(PHOTO_DIR, `${id}.json`), JSON.stringify(item, null, 2));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error("[ichikawa] photo save failed:", err?.message || err);
    return res.status(500).json({ error: "de foto kon niet bewaard worden" });
  }
});

// A body that blows past the 25mb parser limit never reaches the handler above, so
// it would fall through to Express' raw HTML error page. Catch that one case and
// answer with the same friendly Dutch line the handler's own size check uses.
app.use((err, req, res, next) => {
  if (req.path === PHOTO_UPLOAD_PATH && (err?.type === "entity.too.large" || err?.status === 413)) {
    return res.status(413).json({ error: "die foto is te groot (max 15 MB) — maak 'm wat kleiner" });
  }
  return next(err);
});

// The still-to-process queue — newest first. A missing dir just means an empty inbox.
app.get("/api/recipes/photo-inbox", (_req, res) => {
  try {
    return res.json({ items: readPhotoInbox().filter((it) => it.status === "pending") });
  } catch {
    return res.status(500).json({ error: "failed to read photo inbox" });
  }
});

// The image bytes themselves (thumbnails in the UI). The real filename comes from
// the sidecar, never from the URL, so the id alone can't reach another file.
app.get("/api/recipes/photo/:id/image", (req, res) => {
  const id = req.params.id;
  if (!id || /[\\/]/.test(id) || id.includes("..")) return res.status(400).json({ error: "invalid id" });
  const sidecar = path.join(PHOTO_DIR, `${id}.json`);
  if (!existsSync(sidecar)) return res.status(404).json({ error: "photo not found" });
  try {
    const item = JSON.parse(readFileSync(sidecar, "utf8"));
    const name = String(item?.file || "");
    if (!name || /[\\/]/.test(name) || name.includes("..")) return res.status(404).json({ error: "photo not found" });
    const file = path.join(PHOTO_DIR, name);
    if (!existsSync(file)) return res.status(404).json({ error: "photo not found" });
    res.type(item.mime || "application/octet-stream");
    return res.sendFile(file);
  } catch {
    return res.status(500).json({ error: "failed to read photo" });
  }
});

// Drop a photo from the inbox — image + sidecar both go. A real delete (not a soft
// keep:false like recipes): an unwanted snapshot has nothing worth keeping.
app.delete("/api/recipes/photo/:id", (req, res) => {
  const id = req.params.id;
  if (!id || /[\\/]/.test(id) || id.includes("..")) return res.status(400).json({ error: "invalid id" });
  const sidecar = path.join(PHOTO_DIR, `${id}.json`);
  if (!existsSync(sidecar)) return res.status(404).json({ error: "photo not found" });
  try {
    let name = "";
    try { name = String(JSON.parse(readFileSync(sidecar, "utf8"))?.file || ""); } catch {}
    if (name && !/[\\/]/.test(name) && !name.includes("..")) {
      const file = path.join(PHOTO_DIR, name);
      if (existsSync(file)) unlinkSync(file);
    }
    unlinkSync(sidecar);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "failed to delete photo" });
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

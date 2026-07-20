// One-off: re-clean the existing Ichikawa recipe corpus in place. Reads every
// data/recipes/*.json, applies cleanText() to title/subtitle/ingredient
// names/step text, and writes back — preserving keep, per-step minutes/mode, and every
// other field. Idempotent: only rewrites files that actually change.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cleanText } from './lib-clean.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../data/recipes');

let changed = 0, total = 0;
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  total++;
  const p = path.join(DIR, f);
  const r = JSON.parse(readFileSync(p, 'utf8'));
  const before = JSON.stringify(r);
  if (r.title != null) r.title = cleanText(r.title);
  if (r.subtitle != null) r.subtitle = cleanText(r.subtitle);
  if (Array.isArray(r.ingredients)) r.ingredients = r.ingredients.map(i => ({ ...i, name: i.name != null ? cleanText(i.name) : i.name }));
  if (Array.isArray(r.steps)) r.steps = r.steps.map(s => ({ ...s, text: s.text != null ? cleanText(s.text) : s.text }));
  if (JSON.stringify(r) !== before) { writeFileSync(p, JSON.stringify(r, null, 2)); changed++; }
}
console.log(`cleaned ${changed}/${total} recipe files`);

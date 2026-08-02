// Ichikawa 市川 — photo → recipe.
//
// Turns one or more photographed recipe pages (a cookbook spread, a recipe card,
// a magazine clipping) into ONE recipe in the corpus shape that
// engine/enrich-recipes.mjs produces for URLs — same fields, same conventions —
// so a photo recipe and a scraped recipe are indistinguishable downstream.
//
// Several photos are read as several pages of the SAME dish (ingredients on the
// left page, method on the right). One recipe comes back, never several.
//
// Unlike the rest of the engine this DOES call an LLM (Claude, vision), so it
// needs credentials and costs money per conversion. Nothing calls it implicitly:
// the server only runs it when the user presses the button.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5'; // exact string — do NOT append a date suffix
const MAX_TOKENS = 16000;      // room for thinking + a long recipe, still non-streaming-safe

// The vision API reads these; HEIC/HEIF it does not, even though the inbox
// stores them (iOS usually hands over JPEG, but a file picker can hand over the
// original). Callers turn this into a human sentence instead of an API error.
export const VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Mirrors engine/enrich-recipes.mjs — a photo recipe gets the same kind of id as
// a scraped one (lowercase, dash-separated, no diacritics).
function slugify(s) {
  return (
    String(s || 'recipe')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'recipe'
  );
}

// Nullable field, spelled the way the structured-outputs schema validator accepts
// (a `type: [..., "null"]` union is not in the supported subset; `anyOf` is).
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

// The shape Claude must answer in. Constrained server-side, so the response is
// always parseable JSON in exactly this form — no prompt-level "please return
// JSON" hoping. Every object carries additionalProperties:false + required,
// which the validator demands.
const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isRecipe', 'title', 'subtitle', 'servings', 'ingredients', 'steps',
             'totalTime', 'prepTime', 'activeTime', 'tags', 'cuisine'],
  properties: {
    // The one escape hatch: a photo of a cat is not a recipe, and the model
    // saying so is far better than it inventing a plausible dish.
    isRecipe: { type: 'boolean' },
    title: { type: 'string' },
    subtitle: nullable({ type: 'string' }),
    servings: nullable({ type: 'integer' }),
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'qty', 'unit'],
        properties: {
          name: { type: 'string' },
          qty: nullable({ type: 'number' }),
          unit: nullable({ type: 'string' }),
        },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'minutes', 'mode'],
        properties: {
          text: { type: 'string' },
          minutes: nullable({ type: 'number' }),
          mode: nullable({ type: 'string', enum: ['active', 'passive'] }),
        },
      },
    },
    totalTime: nullable({ type: 'integer' }),
    prepTime: nullable({ type: 'integer' }),
    activeTime: nullable({ type: 'integer' }),
    tags: { type: 'array', items: { type: 'string' } },
    cuisine: nullable({ type: 'string' }),
  },
};

const SYSTEM = `You read photographed recipe pages and transcribe them.

Transcribe what is on the page. Do not invent ingredients, steps, quantities or
times that are not there, and do not "improve" the recipe. Keep the recipe in the
language it is written in — do not translate it.

If several images are given, they are pages of ONE recipe (for example
ingredients on one page and the method on another): merge them into a single
recipe and do not repeat content that appears on both.

Field notes:
- ingredients: one row per line on the page. Split the amount off into qty (a
  number) and unit (g, ml, tbsp, cloves…), leaving the rest in name. When a line
  has no clear amount, use null for qty and unit and keep the line whole in name.
  Convert fractions (½ → 0.5) and use the lower number of a range.
- steps: one row per numbered step, text verbatim. minutes = the cooking time
  that step states, else null. mode = "passive" when the step is waiting
  (simmering, resting, oven time) and "active" when it needs hands.
- totalTime / prepTime / activeTime: minutes, only when the page states them.
- tags: only what the page labels the dish (vegetarian, dessert…), else empty.
- Set isRecipe to false when the images are not a recipe at all; in that case
  leave the other fields empty.`;

// The credential preflight the server uses to answer "not configured" cleanly
// instead of letting the SDK throw mid-request. The SDK also resolves an
// `ant auth login` profile, but a headless PM2 server realistically has a key.
export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// Ask Claude to read the pages. `images` is [{ base64, mime }] in page order.
// Server-side refusal fallbacks are on: if the safety classifiers decline the
// request, the API re-runs it on Anthropic's recommended fallback model inside
// the same call instead of handing us a dead end.
async function askClaude(client, images, note) {
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime, data: img.base64 },
  }));
  content.push({
    type: 'text',
    text: note
      ? `Transcribe the recipe on these ${images.length} page(s). The photo was filed with this note: "${note}".`
      : `Transcribe the recipe on these ${images.length} page(s).`,
  });

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    // Transcription, not deep reasoning — medium keeps the bill (and the wait)
    // down without losing accuracy on a dense cookbook page.
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECIPE_SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  try {
    return await client.beta.messages.create({
      ...body,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    // An SDK/account that doesn't know the fallback beta must not cost the user
    // the whole feature — retry once on the plain endpoint.
    const msg = String(err?.message || '');
    if (!/fallback|beta/i.test(msg)) throw err;
    return client.messages.create(body);
  }
}

// Pull the model's JSON out of the response, refusing loudly rather than
// half-parsing: a truncated or declined answer is not a recipe.
function readExtraction(res) {
  if (res.stop_reason === 'refusal') {
    throw new Error('__refused__');
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('__truncated__');
  }
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new Error('__empty__');
  return JSON.parse(text);
}

// Coerce the model's answer into the corpus shape. Everything the UI and the
// shopping list read (ingredients/steps rows, times, keep, addedDate) ends up
// exactly as engine/enrich-recipes.mjs writes it.
function toRecipe(x, { photoIds, note }) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const title = str(x.title) || 'Photographed recipe';
  return {
    id: slugify(title),
    source: 'photo',
    title,
    subtitle: str(x.subtitle) || note || null,
    servings: num(x.servings),
    ingredients: (Array.isArray(x.ingredients) ? x.ingredients : [])
      .map((it) => ({ name: str(it?.name), qty: num(it?.qty), unit: str(it?.unit) }))
      .filter((it) => it.name),
    steps: (Array.isArray(x.steps) ? x.steps : [])
      .map((s) => ({
        text: str(s?.text),
        minutes: num(s?.minutes),
        mode: s?.mode === 'passive' ? 'passive' : s?.mode === 'active' ? 'active' : null,
      }))
      .filter((s) => s.text),
    totalTime: num(x.totalTime),
    activeTime: num(x.activeTime),
    tags: (Array.isArray(x.tags) ? x.tags : []).map((t) => str(t)).filter(Boolean),
    cuisine: str(x.cuisine),
    prepTime: num(x.prepTime),
    // The first page doubles as the dish photo. It 404s if that photo is later
    // deleted from the inbox — the card falls back to its pastel tile.
    image: photoIds.length ? `/api/recipes/photo/${encodeURIComponent(photoIds[0])}/image` : null,
    nutrition: null,
    sourceUrl: null,
    photoIds,
    addedDate: new Date().toISOString(),
    keep: true,
  };
}

// Read the pages, return a corpus-shaped recipe. Throws with a sentinel message
// the server maps to a human sentence:
//   __no_key__     no credentials configured on this host
//   __unreadable__ a page is in a format the vision API can't read (HEIC)
//   __not_recipe__ the photos aren't a recipe
//   __refused__ / __truncated__ / __empty__  the model couldn't answer
export async function photosToRecipe(images, { note = '', photoIds = [] } = {}) {
  if (!images.length) throw new Error('__empty__');
  if (!hasCredentials()) throw new Error('__no_key__');
  if (images.some((img) => !VISION_MIME.has(img.mime))) throw new Error('__unreadable__');

  const client = new Anthropic();
  const extracted = readExtraction(await askClaude(client, images, note));
  if (extracted?.isRecipe === false) throw new Error('__not_recipe__');
  const recipe = toRecipe(extracted, { photoIds, note });
  if (!recipe.ingredients.length && !recipe.steps.length) throw new Error('__not_recipe__');
  return recipe;
}

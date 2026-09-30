# Ichikawa (市川) — Market Scout · Build Plan

Personal pet operative. Accent **lime `#84cc16`**. A **recipe engine → weekly shopping list**,
housed **inside the kage-gumi runtime** with its **own branded surface** — not a separate repo.

> **Housing decision (Ei counsel, 2026-07-05).** Branding, repo, and runtime are three separate
> knobs; only branding needed turning. Ichikawa keeps the kage-gumi repo + live runtime (free
> hosting, PM2, Tailscale/Cloudflare reach) but renders under its own skin on its own route, so
> it never appears in the professional KG showcase. Built modular-within-KG so later extraction
> stays cheap **if** it ever goes multi-user/public. Falsifier: if Ichikawa heads toward
> family/multi-user or a public URL with logins → fork then, before it entangles.

---

## v1 goal

Build a **recipe corpus** from three sources → generate a **weekly shopping list** from it.

Recipe sources:
1. **HelloFresh box history** (authenticated pull — recipes actually cooked)
2. **Own proposals** (manual add)
3. **Photo → recipe** (snap a cookbook page / card, Claude vision → structured, stored)

**Recipe view is time-oriented** — Steven cooks for time-efficiency, so every recipe shows its
phases with **per-phase duration**, a **total split into hands-on (active) vs waiting (passive)**,
and parallel-work tips ("while the rice cooks, chop the veg"). This is a core v1 screen.

**Deferred to v2+ (explicitly out of v1):** store-price scraping, cheapest-store, routing/maps,
promo watch, pantry/inventory.

---

## Decisions locked (2026-07-05)

| Axis | Choice |
|---|---|
| Grocery data method | Live scrape/fetch (not manual/LLM) |
| Recipe seed | HelloFresh **account box history** (authenticated), not the public archive |
| Build sequence | **Branded UI first**, engine wired in behind it (seed with sample recipes so it's not empty) |
| Promos | Deferred |
| Housing | Inside kage-gumi repo + runtime; personal data gitignored under `_output/ichikawa/` |
| Servings | **2 people** (default recipe scaling) |
| Weekly plan | **5 dinners** per plan |

## Open — to confirm

- HelloFresh credentials → KG secrets; auth-flow risk (bot protection → maybe manual session capture)
- Box-history depth (how many past recipes the account actually exposes → seed size)

---

## Recipe data model

`_output/ichikawa/recipes/` (gitignored — personal), one JSON per recipe + a corpus index.

```
{
  id,                              // stable id (HelloFresh hex id, or generated for own/photo)
  source: "hellofresh"|"own"|"photo",
  title, subtitle,
  servings,                        // base servings the quantities are for
  ingredients: [{ name, qty, unit }],
  steps: [{ text, minutes, mode:"active"|"passive" }],  // per-phase timing → cooking view
  totalTime, activeTime,           // active = hands-on; the rest = waiting/cooking
  tags: [ ... ], cuisine, prepTime,
  image,                           // url or stored path under recipes/photos/
  nutrition?,                      // optional
  sourceUrl?, addedDate,
  keep: true                       // curation flag
}
```

Weekly plan: `{ week, selectedRecipeIds:[], servingsTarget, generatedList }`.

---

## Styling — kawaii bento restaurant (LOCKED 2026-07-05)

Ichikawa **drops the dark Kage-gumi aesthetic entirely** — light, cute, fluffy, kawaii Japanese
restaurant. Style tile: <https://claude.ai/code/artifact/1237e43a-a8b9-4d6e-8c31-89d2288e3660>

- **Palette:** rice-cream `#FFF6EA` ground · sakura `#FF9DB2` (primary) · matcha `#93CFA0`
  (secondary — the old lime, kawaii-fied) · tamago `#FFCE63` · azuki `#D65B78` (deep pop) ·
  ramune `#8FD3DE` · ink `#5B4750` (warm plum-brown; no pure black/white).
- **Type:** M PLUS Rounded 1c (rounded Japanese gothic — handles 市川 + kana) + Baloo 2, self-hosted/embedded.
- **Shapes:** big radii (18–28px), soft layered shadows ("fluffy"), pill buttons.
- **Motif:** the **bento box** — recipe library = compartments; the weekly plan *is* a bento box
  (5 lacquer-tray compartments to fill → shopping list assembles itself).
- **Characters:** a small cute SVG mascot set (Onigiri-chan, Ichikawa the cat scout, Tamago-chan,
  Matcha-kun) tied to app states (empty / added / loading / done).
- **Cooking-mode timing:** pink chip = hands-on (active), blue chip = waiting (passive).
- **Dark mode:** PARKED — v1 is light-only. "Evening izakaya" (warm aubergine + lantern glow) kept as a future option.

---

## Phases

1. **Branded surface** *(Ren / frontend)* — `#ichikawa` route inside KG: lime skin, own identity,
   shadow-crew chrome dropped. Recipe grid + weekly-plan shell. Seeded with a few sample recipes.
2. **HelloFresh auth + box-history pull** — creds in KG secrets; Playwright login **or** captured
   session token; pull cooked recipes → recipe IDs. Fallback: one-time manual session capture.
3. **Recipe enrichment** — per recipe ID, fetch the recipe page, extract **JSON-LD `Recipe`**
   (ingredients/steps/servings/image) → normalize → corpus. **Derive per-phase timing**
   (minutes + active/passive per step) via an LLM pass over the instructions — HelloFresh exposes
   only the total time — stored **editable** so Steven can correct it.
4. **Manual add + photo → recipe** — add form; image upload → Claude vision extract → same schema
   (image stored under `recipes/photos/`).
5. **Weekly shopping-list generator** — select recipes → aggregate + dedupe ingredients
   (unit-aware, scale to servings target) → categorized list (by aisle).

---

## Feasibility (verified 2026-07-05)

- HelloFresh recipe **detail** pages are public, no login, and carry schema.org **JSON-LD** —
  clean structured extraction (title, `recipeIngredient[]`, `recipeInstructions[]`, servings,
  image, nutrition). Existing precedent: `recipe-scrapers` lib has a HelloFresh handler; a
  Belgium-specific scraper exists publicly.
- Recipes are in **Dutch** (Belgian site) — correct for shopping in Gent.
- The **account/box-history** side is the only authenticated part; recipe detail stays public.

## Risks

- **HelloFresh login bot-protection** → headless auth may be brittle; fallback = manual session capture.
- **Box-history depth** unknown → seed may be small; can top up from the public archive if needed.
- **Personal-data privacy** → all Ichikawa data gitignored under `_output/ichikawa/`.
- **Per-phase timing isn't in HelloFresh** → derived via LLM estimate from step text; user-editable, so accuracy improves with correction.

---

## Store route map — SHIPPED 2026-07-19 (geometry needs a correction pass)

Ichi's shopping list is bucketed into Jumbo Foodmarkt Gent zones and re-ordered along
the store's walking path, drawn as a schematic floorplan + walk-ordered checklist.

- `data/ichikawa/jumbo-gent-store.json` — 17 zones (geometry + accent) + Dutch
  ingredient→zone keyword lexicon + `overrides`. Captured from the official
  [Jumbo Gent plattegrond PDF](https://www.jumbo.com/dam/belgie/winkels/Jumbo-BE-Foodmarkt-Gent-Plattegrond.pdf).
- `frontend/src/lib/jumboRoute.js` — `normalize` (strips HelloFresh `½ stuk(s)` /
  `[plantaardige]` artifacts) · `classify` (**word-start** matching: compounds like
  knoflook→knoflookteen match, but `ui` does NOT leak into `suiker`/`kruiden`/`bouillon`)
  · `buildRoute`. Overrides beat the lexicon (`bouillon` → pantry, never the meat counter).
- `IchikawaSurface.jsx` — "🗺️ Bekijk looproute" button → `RouteModal` + floorplan SVG.
- Standalone proof: `_output/ichikawa/route-map/jumbo-gent-route.html` (gitignored
  personal tree — regenerate by inlining the store JSON + classifier).

**TODO — floorplan accuracy.** Zone geometry is a hand-built *schematic*: it preserves the
real topology (fresh perimeter top/right, dry grid left, frozen centre, ingang bottom-centre,
kassa bottom-left) but the positions are **not 100% faithful** to the actual store. Steven
flagged this 2026-07-19; a correction pass against the PDF is deferred. Consequence: the
drawn path crosses the store more than a real lap would. Zone *membership* and walk *order*
are unaffected — only the drawn coordinates.

Possible follow-ups: truer zone coordinates, less spaghetti path routing (aisle-aware /
orthogonal), per-store variants (Delhaize / AH), manual re-bucket override in the UI.

## Deferred backlog (v2+)

- Store price scrape — Jumbo (home), Delhaize Dok Noord, Delhaize Sint-Amandsberg, AH Oostakker
  (note: Delhaize branches may be franchised → per-branch price variance vs online catalog)
- Cheapest-per-item (split shop) vs cheapest-single-store
- Promo/deal watch (weekly folders)
- Pantry / inventory (don't re-list staples you have)

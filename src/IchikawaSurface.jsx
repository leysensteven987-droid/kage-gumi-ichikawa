/**
 * @vibe-author STLE @version 5 @date 21JUL26 @comment Weekrandomizer — "Verras me" vult de hele week (MA–ZO) met 6 willekeurige recepten; het gerecht van dinsdag draait door naar woensdag (1× koken, 2× eten). Weekplan opent van 5 werkdagen naar een volledige 7-daagse week.
 * @vibe-author STLE @version 4 @date 21JUL26 @comment Desktop "management desk" — ≥1100px (ONE JS breakpoint) lays PLAN | BIBLIOTHEEK | SHOP·KOOK side-by-side from the same render pieces; phone composition below the breakpoint unchanged
 * @vibe-author STLE @version 3 @date 21JUL26 @comment Port "De dagronde" into the standalone PWA — rewired onto /api/recipes + self-hosted /fonts + root data/ store JSON
 * @vibe-author STLE @version 2 @date 21JUL26 @comment Redesign — "De dagronde": three-mode companion (献 Plan / 買 Shop / 火 Kook), paw-trail winkelronde, persisted weekplan + checklist, bottom-sheet recipe cards, dual-theme ground
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import STORE from "../data/jumbo-gent-store.json";
import { buildRoute } from "./lib/jumboRoute.js";

/* ──────────────────────────────────────────────────────────────────────────
   ICHIKAWA · 市川 · MARKET SCOUT   (kage-gumi personal operative)

   "DE DAGRONDE" — a phone-first, one-thumb kitchen companion. The surface is
   organised around the three real jobs, each its own MODE (persisted):

     • 献 PLAN — couch job. Week bento rail (7 days, snap-scroll), porties +
                 eiwitbalans summary, and the recipe library as big tap rows
                 (search / soort / tijd / tag filters kept).
     • 買 SHOP — standing-in-the-aisle job. The walk-ordered checklist with
                 52px whole-row taps, and the SIGNATURE paw-print trail: the
                 cat scout's route INGANG → aisles → KASSA. A completed aisle
                 earns a paw stamp. Floorplan modal kept.
     • 火 KOOK — at-the-stove job. Tonight's dish: act/wait split, mise en
                 place, and the per-phase step timeline inline.

   The weekly plan, servings, checklist ticks and mode PERSIST in localStorage
   (kg-ich-*) — a grocery tool must survive a reload in the aisle.

   ≥1100px — the "MANAGEMENT DESK" (desktop is for PLANNING the dagronde, the
   phone for executing it). ONE JS breakpoint (WIDE_MQ) flips the shell: the
   SAME section renderers rearrange into three columns — 献 PLAN (week board +
   porties + stats) | 皿 BIBLIOTHEEK (curation, card grid, '/' focuses search)
   | a 買 SHOP / 火 KOOK side panel (S / K keys). Nothing is duplicated: below
   the breakpoint the phone composition renders exactly as before, and all
   state/persistence/API wiring is shared. Sheets become centered modals on
   the desk; hover lifts are gated behind @media(hover:hover).

   Mount: this surface IS the standalone app — main.jsx renders it bare, so
   `embedded` defaults false → position:fixed full-viewport takeover. Passing
   `embedded` switches the root to position:absolute for hosting inside a
   visualViewport-sized shell (avoids the iOS fixed/large-viewport trap).
   Sheets/toasts are position:absolute children of the root for the same reason.

   The page GROUND + text directly on it read the --kg-* veil tokens when a
   host theme defines them; standalone (no host vars) they fall back to the
   kawaii cream ground. The cream cards are fixed, self-consistent pastel
   islands (cream bg + plum ink) either way. NB hard rule: never `var(--x)55`
   hex-alpha on a var — alpha only via color-mix. Data comes from
   GET /api/recipes (the standalone Express server); the tiny inline fallback
   set keeps the shell rendering when the API is unreachable.

   KG-authored: root carries data-kg-* attribution; children use kg-ich-*.
   Fonts: M PLUS Rounded 1c + Baloo 2, self-hosted from /fonts (offline PWA).
   ────────────────────────────────────────────────────────────────────────── */

// ─── Kawaii bento palette (from the approved style tile — used exactly) ──────
const RICE      = "#FFF6EA";  // warm rice-cream ground
const RICE2     = "#FDEEDC";
const CARD      = "#FFFDF9";
const INK       = "#5B4750";  // warm plum-brown — never pure black
const INK_SOFT  = "#9A8189";
const SAKURA    = "#FF9DB2";  // primary
const SAKURA_DP = "#F26D8B";
const MATCHA    = "#93CFA0";  // secondary
const MATCHA_DP = "#5FAE77";
const TAMAGO    = "#FFCE63";
const RAMUNE    = "#8FD3DE";  // passive / cool
const RAMUNE_DP = "#3F9AA6";
const AZUKI     = "#D65B78";  // deep pop
const LINE      = "#F0DFCD";
const BLUSH     = "#FFC2CE";
const LACQUER   = "#4B3B42";  // bento tray

const SHADOW_SOFT = "0 6px 18px rgba(206,150,116,.20), 0 2px 6px rgba(206,150,116,.12)";
const SHADOW_LIFT = "0 14px 34px rgba(206,150,116,.26)";
const R_LG = 26, R_MD = 18, R_SM = 12, R_PILL = 999;

const F_ROUND   = "'M PLUS Rounded 1c','Baloo 2',ui-rounded,'Segoe UI',system-ui,sans-serif";
const F_DISPLAY = "'Baloo 2','M PLUS Rounded 1c',ui-rounded,system-ui,sans-serif";

// The week plans all 7 days (MA–ZO). Six distinct recipes fill the seven day-
// slots: the "verras me" randomizer cooks Tuesday's dish twice (DI + WO), so a
// full week is 6 recipes over 7 dinners. Manual planning honours the same cap.
const MAX_DINNERS = 7;

// Fixed leftover pairing for the randomizer: the recipe placed on DINSDAG (day
// index 1) is also served WOENSDAG (index 2) — one cook, two dinners. Every
// other day gets its own recipe. Day indices follow DAY_ABBR (MA=0 … ZO=6).
const LEFTOVER_FROM = 1; // dinsdag
const LEFTOVER_TO   = 2; // woensdag
// pick-index per day slot: MA,DI,WO,DO,VR,ZA,ZO → 6 distinct recipes (DI==WO).
const RANDOM_DAY_PICKS = [0, 1, 1, 2, 3, 4, 5];

// ONE JS breakpoint — the single place a width lives. Desktop CSS keys off the
// .kg-ich-desk / .kg-ich--wide classes this sets, never off a second number.
const WIDE_MQ = "(min-width: 1100px)";

// Cuisine → food-tile glyph + PASTEL gradient. Self-contained (no external
// images) so the surface renders identically offline on the box.
const CUISINE = {
  "Midden-Oosters": { emoji: "🥙", a: "#FFE7C2", b: "#FFD3DE" },
  "Italiaans":      { emoji: "🍝", a: "#FFE1CC", b: "#FFC7D0" },
  "Vis":            { emoji: "🐟", a: "#D9F0F6", b: "#C7E7F2" },
  "Amerikaans":     { emoji: "🍔", a: "#FFE9C4", b: "#FFD9AE" },
  "Indiaas":        { emoji: "🍛", a: "#FFE6B0", b: "#FFCE8A" },
  "Vegetarisch":    { emoji: "🥗", a: "#E4F3D9", b: "#CBEBD2" },
};
const cuisineOf = c => CUISINE[c] || { emoji: "🍽️", a: "#FFE7C2", b: "#FFD3DE" };

// Time-filter buckets (totalTime, minutes). "Alles" = no filter (max:null); a recipe
// with no totalTime only ever shows there, never under a numeric bucket.
const TIME_BUCKETS = [
  { key: "all", label: "Alles",     max: null },
  { key: "20",  label: "≤ 20 min",  max: 20 },
  { key: "30",  label: "≤ 30 min",  max: 30 },
  { key: "45",  label: "≤ 45 min",  max: 45 },
];

// ─── Main-ingredient category ───────────────────────────────────────────────
// The HelloFresh-scraped corpus has no reliable protein field (cuisine is often
// "0", tags are generic "Hoofdgerecht"), so the category is DERIVED from the
// title + ingredient names by keyword. One recipe → exactly one bucket.
//
// The trap: "Plantaardige kip" / "veggie gehakt" contain meat words but are veg.
// Guard 1 — a plant marker in the TITLE forces veg regardless of protein words
// (HelloFresh always names the veggie variant in the title). Guard 2 — a plant-
// based INGREDIENT name is dropped before the meat/fish scan.
const PLANT_RE = /(plantaardig\w*|vegg?ie|vegetarisch\w*|vegan|\bvega\b)/;

// NB: no bare 3-letter English tokens like "cod"/"hake" — they collide as
// substrings ("balsamicodressing" → "cod"). Dutch names (kabeljauw/heek) cover them.
const FISH_KW = [
  "vis", "zalm", "salmon", "tonijn", "tuna", "garnaal", "garnalen", "shrimp", "prawn",
  "scampi", "kabeljauw", "pangasius", "bream", "brasem", "dorade", "forel", "trout",
  "makreel", "mackerel", "haring", "herring", "sardine", "ansjovis", "anchov", "mossel",
  "mussel", "inktvis", "calamari", "squid", "octopus", "schol", "tilapia",
  "pollock", "koolvis", "wijting", "heek", "zeewolf", "zeebaars",
  "seabass", "victoriabaars", "krab", "kreeft", "lobster", "surimi", "vissticks",
  "lekkerbek", "kibbeling", "paling", "tong", "snoekbaars", "roodbaars",
];
const CHICKEN_KW = [
  "kip", "chicken", "kalkoen", "turkey", "poulet", "gevogelte", "drumstick", "poussin",
];
const MEAT_KW = [
  "rund", "runder", "beef", "biefstuk", "steak", "varken", "pork", "spek", "bacon", "worst",
  "sausage", "chorizo", "salami", "ham", "gehakt", "mince", "gyros", "shoarma", "shawarma",
  "lams", "lamb", "kalfs", "veal", "eend", "duck", "merguez", "spareribs", "ribs", "pancetta",
  "prosciutto", "coppa", "ossenhaas", "entrecote", "ribeye", "rib-eye", "sucade", "procureur",
  "draadjesvlees", "hamburger", "cheeseburger", "kapsalon",
];

// Returns 'fish' | 'chicken' | 'meat' | 'veg'. Fish wins over poultry wins over
// red/other meat (so a kip+spek dish reads as Kip); no animal protein → veg.
function categoryOf(r) {
  const title = (r.title || "").toLowerCase();
  if (PLANT_RE.test(title)) return "veg"; // explicit plant-based variant
  const ingNames = (r.ingredients || [])
    .map(i => (i.name || "").toLowerCase())
    .filter(n => !PLANT_RE.test(n)); // drop plant-based ingredients (fake kip/gehakt)
  // Strip stock/sauce mentions — chicken/beef/fish STOCK (bouillon) and fish sauce
  // are seasonings, not the dish's protein (else every chorizo/veg dish with
  // "kippenbouillon" reads as Kip). Then scan the remaining text.
  const hay = (title + " " + ingNames.join(" "))
    .replace(/\w*bouillon\w*|\w*fond\b|vissaus|fish sauce/g, " ");
  const has = arr => arr.some(k => hay.includes(k));
  if (has(FISH_KW)) return "fish";
  if (has(CHICKEN_KW)) return "chicken";
  if (has(MEAT_KW)) return "meat";
  return "veg";
}

// Main-category filter chips. "all" = no filter.
const CATEGORY_FILTERS = [
  { key: "all",     label: "Alles", emoji: "" },
  { key: "meat",    label: "Vlees", emoji: "🥩" },
  { key: "chicken", label: "Kip",   emoji: "🐔" },
  { key: "fish",    label: "Vis",   emoji: "🐟" },
  { key: "veg",     label: "Vega",  emoji: "🥗" },
];

// ─── Theme-aware ground tokens ──────────────────────────────────────────────
// The kawaii brand stays: cards, chips and accents are fixed pastel islands
// that are self-consistent (cream bg + plum ink) in either theme. Only the
// page GROUND and the text sitting DIRECTLY on it follow the KG veil tokens,
// so the surface stays legible on graphite (dim) and washi (light). NB hard
// rule: never `var(--x)55` hex-alpha on a var — alpha only via color-mix.
const G_BG    = `var(--kg-bg-page, ${RICE})`;
const G_TEXT  = `var(--kg-text-body, ${INK})`;
const G_MUTED = `var(--kg-text-muted, ${INK_SOFT})`;
const G_LINE  = `var(--kg-border, ${LINE})`;
const G_DOTS  = `color-mix(in srgb, var(--kg-border, ${LINE}) 60%, transparent)`;

// ─── Week helpers — tonight-hero + 7-day weekmenu rail ──────────────────────
const DAY_ABBR = ["MA", "DI", "WO", "DO", "VR", "ZA", "ZO"];
const DAY_FULL = ["MAANDAG", "DINSDAG", "WOENSDAG", "DONDERDAG", "VRIJDAG", "ZATERDAG", "ZONDAG"];
const MON_ABBR = ["JAN", "FEB", "MRT", "APR", "MEI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEC"];
function weekInfo(now = new Date()) {
  const todayIdx = (now.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // ISO week via nearest Thursday
  const week = Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7);
  return { todayIdx, days, week };
}
const fmtD = d => `${String(d.getDate()).padStart(2, "0")} ${MON_ABBR[d.getMonth()]}`;

// "3 u 40" style duration for the week-stats panel.
function fmtDur(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} u ${String(r).padStart(2, "0")}` : `${h} u`;
}

// Protein-category meta for the weekmenu day cards + eiwitbalans meter.
// Kawaii-mapped: vlees=azuki, kip=tamago, vis=ramune, vega=matcha.
const CAT_META = {
  meat:    { label: "VLEES", bar: AZUKI,  fg: AZUKI },
  chicken: { label: "KIP",   bar: TAMAGO, fg: "#C58A16" },
  fish:    { label: "VIS",   bar: RAMUNE, fg: RAMUNE_DP },
  veg:     { label: "VEGA",  bar: MATCHA, fg: MATCHA_DP },
};

// Section heading — label + fading rule + right-hand stamp, kawaii-skinned.
// `onCard`: inside a cream card use fixed kawaii ink; on the themed page ground
// use KG tokens so both themes read.
function SecTag({ k, label, right, onCard = false }) {
  const muted = onCard ? INK_SOFT : G_MUTED;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 12px" }}>
      <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", color: SAKURA_DP, whiteSpace: "nowrap" }}>
        {k} {label}
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${BLUSH}, transparent)` }} />
      {right ? <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: muted, whiteSpace: "nowrap" }}>{right}</span> : null}
    </div>
  );
}

// Trim a scaled quantity to a clean display number (no trailing .00 / long floats).
function fmtQty(n) {
  if (n == null || isNaN(n)) return "";
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(/\.?0+$/, "");
}

// Normalize steps to objects (back-compat: a legacy string step → active, no minutes).
function normSteps(steps) {
  return (steps || []).map(s =>
    typeof s === "string" ? { text: s, minutes: null, mode: "active" } : s
  );
}

// Cooking-mode timing. totalTime = wall-clock (accounts for parallel work),
// activeTime = hands-on. Falls back gracefully if a recipe lacks the new fields.
function cookTiming(r) {
  const steps = normSteps(r.steps);
  const stepSum = steps.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  const total = Number(r.totalTime) || Number(r.prepTime) || stepSum || 0;
  let active = r.activeTime;
  if (active == null)
    active = steps.filter(s => s.mode !== "passive").reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  active = Math.min(Math.max(0, active), total);
  const passive = Math.max(0, total - active);
  const longestPassive = steps.filter(s => s.mode === "passive").sort((a, b) => (b.minutes || 0) - (a.minutes || 0))[0];
  const tip =
    r.parallelTip ||
    (longestPassive
      ? `Slim: terwijl "${longestPassive.text}" (${longestPassive.minutes}′) loopt, bereid je alvast de andere onderdelen voor.`
      : "");
  return { steps, total, active, passive, tip };
}

const API_GET = (p) => fetch(p).then(r => (r.ok ? r.json() : Promise.reject(r.status)));

// ─── Persistence — the plan must survive a reload in the aisle ──────────────
const LS = {
  plan:     "kg-ich-plan",
  servings: "kg-ich-servings",
  checked:  "kg-ich-checked",
  mode:     "kg-ich-mode",
  deskSide: "kg-ich-desk-side", // desktop-only: which job the side panel shows
};
function lsRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function lsWrite(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// The three modes — each maps to one real job (couch / aisle / stove).
const MODES = [
  { id: "plan", k: "献", label: "Plan" },
  { id: "shop", k: "買", label: "Shop" },
  { id: "cook", k: "火", label: "Kook" },
];

// Grocery-line identity: name + unit (unit-aware dedupe key, also the tick key).
const keyOf = it => `${it.name}__${it.unit || ""}`;

// ─── Mascots — inline SVG sticker set (dot eyes, blush, smile). Each tied to
//     an app state; all self-contained, no external assets. ─────────────────
function Mascot({ type, size = 68, bob = true, style }) {
  const face = (
    <g>
      <ellipse cx="30" cy="41" rx="4" ry="5.4" fill={INK} />
      <ellipse cx="50" cy="41" rx="4" ry="5.4" fill={INK} />
      <ellipse cx="21.5" cy="48" rx="5" ry="3" fill={BLUSH} opacity="0.9" />
      <ellipse cx="58.5" cy="48" rx="5" ry="3" fill={BLUSH} opacity="0.9" />
      <path d="M35 47 Q40 52.5 45 47" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
    </g>
  );
  let body = null;
  if (type === "onigiri") {
    body = (
      <>
        <path d="M40 7 C25 7 14 26 11 46 C9 60 20 71 40 71 C60 71 71 60 69 46 C66 26 55 7 40 7 Z" fill="#fff" stroke={LINE} strokeWidth="1.5" />
        <path d="M24 55 h32 a5 5 0 0 1 5 5 v6 a5 5 0 0 1 -5 5 h-32 a5 5 0 0 1 -5 -5 v-6 a5 5 0 0 1 5 -5 Z" fill="#4B3B42" />
      </>
    );
  } else if (type === "cat") {
    body = (
      <>
        <path d="M19 24 L26 5 L39 21 Z" fill="#FFE0C7" />
        <path d="M61 24 L54 5 L41 21 Z" fill="#FFE0C7" />
        <path d="M23 20 L27 11 L33 20 Z" fill={BLUSH} opacity="0.7" />
        <path d="M57 20 L53 11 L47 20 Z" fill={BLUSH} opacity="0.7" />
        <circle cx="40" cy="45" r="30" fill="#FFE0C7" />
        <circle cx="40" cy="45.5" r="1.7" fill={SAKURA_DP} />
        <path d="M6 42 H19 M6 49 H19" stroke={INK_SOFT} strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
        <path d="M74 42 H61 M74 49 H61" stroke={INK_SOFT} strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
      </>
    );
  } else if (type === "tamago") {
    body = (
      <>
        <path d="M40 12 C24 12 14 30 14 46 C14 62 26 70 40 70 C54 70 66 62 66 46 C66 30 56 12 40 12 Z" fill="#fff" stroke={LINE} strokeWidth="1.5" />
        <circle cx="40" cy="46" r="15" fill={TAMAGO} />
        <circle cx="35" cy="41" r="4" fill="#FFE08A" />
      </>
    );
  } else if (type === "matcha") {
    body = (
      <>
        <path d="M17 22 h46 a15 15 0 0 1 15 15 v14 a15 15 0 0 1 -15 15 h-46 a15 15 0 0 1 -15 -15 v-14 a15 15 0 0 1 15 -15 Z" fill={MATCHA} />
        <rect x="21" y="26" width="38" height="10" rx="5" fill="#DFF3E2" />
      </>
    );
  }
  return (
    <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden="true"
      className={bob ? "kg-ich-bob" : undefined}
      style={{ filter: "drop-shadow(0 4px 6px rgba(206,150,116,.25))", ...style }}>
      {body}
      {face}
    </svg>
  );
}

// The scout's paw print — trail markers + the "aisle complete" stamp.
function Paw({ size = 16, color = SAKURA_DP, style, className }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className} style={style}>
      <circle cx="5.6" cy="9.4" r="2.6" fill={color} />
      <circle cx="12"  cy="6.6" r="2.9" fill={color} />
      <circle cx="18.4" cy="9.4" r="2.6" fill={color} />
      <path d="M12 11.2 C8.3 11.2 5.6 14 5.6 16.6 C5.6 18.9 7.4 20.4 9.4 19.9 C10.4 19.65 11.2 19.4 12 19.4 C12.8 19.4 13.6 19.65 14.6 19.9 C16.6 20.4 18.4 18.9 18.4 16.6 C18.4 14 15.7 11.2 12 11.2 Z" fill={color} />
    </svg>
  );
}

// Bento-cell meter — 5 lacquer compartments filling with sakura as diners land.
function BentoMeter({ filled, total = MAX_DINNERS, cell = 20 }) {
  return (
    <div role="img" aria-label={`${filled} van ${total} diners gepland`}
      style={{ display: "flex", gap: 5, padding: 5, background: LACQUER, borderRadius: 10 }}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} style={{ width: cell, height: cell, borderRadius: 6,
          background: i < filled ? SAKURA : "#5C4A52",
          boxShadow: i < filled ? "inset 0 -3px 0 rgba(0,0,0,.12)" : "inset 0 2px 3px rgba(0,0,0,.28)",
          transition: "background .25s ease" }} />
      ))}
    </div>
  );
}

// Offline fallback — a tiny subset so the surface is never blank if the API is
// unreachable. The full corpus is served by GET /api/recipes.
const FALLBACK_RECIPES = [
  { id: "fb-bolognese", source: "own", title: "Spaghetti Bolognese", subtitle: "Klassieke rundersaus met Parmigiano",
    servings: 2, cuisine: "Italiaans", prepTime: 30, totalTime: 30, activeTime: 16, tags: ["pasta", "rund"], image: "",
    parallelTip: "Terwijl de saus pruttelt, kook je de spaghetti beetgaar.",
    ingredients: [
      { name: "Spaghetti", qty: 180, unit: "g" }, { name: "Rundergehakt", qty: 250, unit: "g" },
      { name: "Passata", qty: 400, unit: "g" }, { name: "Ui", qty: 1, unit: "stuk" },
      { name: "Knoflook", qty: 2, unit: "tenen" }, { name: "Parmigiano Reggiano", qty: 25, unit: "g" },
    ],
    steps: [
      { text: "Snipper de ui en knoflook.", minutes: 5, mode: "active" },
      { text: "Kook de spaghetti beetgaar.", minutes: 10, mode: "passive" },
      { text: "Bak ui, knoflook en gehakt rul.", minutes: 7, mode: "active" },
      { text: "Voeg passata toe en laat pruttelen.", minutes: 12, mode: "passive" },
      { text: "Serveer met Parmigiano.", minutes: 3, mode: "active" },
    ] },
  { id: "fb-halloumi", source: "own", title: "Halloumi Buddha Bowl", subtitle: "Quinoa, geroosterde groenten en tahindressing",
    servings: 2, cuisine: "Vegetarisch", prepTime: 30, totalTime: 30, activeTime: 17, tags: ["vega", "bowl"], image: "",
    parallelTip: "Terwijl de groenten roosteren, maak je de tahindressing.",
    ingredients: [
      { name: "Halloumi", qty: 225, unit: "g" }, { name: "Quinoa", qty: 150, unit: "g" },
      { name: "Courgette", qty: 1, unit: "stuk" }, { name: "Rode paprika", qty: 1, unit: "stuk" },
      { name: "Tahin", qty: 2, unit: "el" }, { name: "Knoflook", qty: 1, unit: "teen" },
    ],
    steps: [
      { text: "Kook de quinoa gaar.", minutes: 12, mode: "passive" },
      { text: "Snijd en meng de groenten met olie.", minutes: 7, mode: "active" },
      { text: "Rooster courgette en paprika.", minutes: 20, mode: "passive" },
      { text: "Maak een tahindressing.", minutes: 4, mode: "active" },
      { text: "Bak de halloumi en serveer op de bowl.", minutes: 6, mode: "active" },
    ] },
];

export default function IchikawaSurface({ onExit, embedded = false }) {
  const [recipes, setRecipes] = useState([]);
  const [source, setSource]   = useState("");   // 'corpus' | 'seed' | 'empty' | 'offline'
  const [loaded, setLoaded]   = useState(false);

  // ── Persisted state (kg-ich-*) — mode, weekplan, porties, checklist ticks.
  // Defensive parses: a corrupt/legacy value falls back instead of crashing.
  const [mode, setMode] = useState(() => {
    const m = lsRead(LS.mode, "plan");
    return MODES.some(x => x.id === m) ? m : "plan";
  });
  const [selected, setSelected] = useState(() => {
    const v = lsRead(LS.plan, []);
    return Array.isArray(v) ? v.filter(x => typeof x === "string").slice(0, MAX_DINNERS) : [];
  });
  const [servings, setServings] = useState(() => {
    const v = Number(lsRead(LS.servings, 2));
    return Number.isFinite(v) && v >= 1 && v <= 12 ? Math.round(v) : 2;
  });
  const [aisleChecked, setAisleChecked] = useState(() => {
    const v = lsRead(LS.checked, []);
    return new Set(Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  });
  useEffect(() => { lsWrite(LS.mode, mode); }, [mode]);
  useEffect(() => { lsWrite(LS.plan, selected); }, [selected]);
  useEffect(() => { lsWrite(LS.servings, servings); }, [servings]);
  useEffect(() => { lsWrite(LS.checked, [...aisleChecked]); }, [aisleChecked]);

  // ── Desktop desk — ONE JS breakpoint. Below it the phone shell renders
  // exactly as before; above it the same pieces rearrange into three columns.
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(WIDE_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_MQ);
    const on = e => setWide(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // Which job the desk's right panel shows (shop | cook) — persisted under its
  // OWN key so the phone's persisted `mode` is never disturbed by desktop use.
  const [deskSide, setDeskSide] = useState(() => (lsRead(LS.deskSide, "shop") === "cook" ? "cook" : "shop"));
  useEffect(() => { lsWrite(LS.deskSide, deskSide); }, [deskSide]);

  // ── Session state (not persisted)
  const [detail, setDetail]     = useState(null);  // recipe open in the card sheet
  const [showRoute, setShowRoute] = useState(false); // floorplan sheet open?
  const [tag, setTag]           = useState("all"); // library filter (recipe tags)
  const [cat, setCat]           = useState("all"); // main-ingredient filter
  const [search, setSearch]     = useState("");    // keyword search
  const [timeMax, setTimeMax]   = useState(null);  // time bucket (minutes, null = Alles)
  const [removedIds, setRemovedIds] = useState(() => new Set()); // soft-removed (optimistic)
  const [removeNote, setRemoveNote] = useState(null); // gentle failure toast
  const [heroIdx, setHeroIdx]   = useState(null);  // pinned "vanavond" slot; null = auto
  // ── Add-a-recipe-from-URL sheet (works phone + desk; shared renderer)
  const [addOpen, setAddOpen] = useState(false);   // URL sheet open?
  const [addUrl, setAddUrl]   = useState("");      // the pasted recipe link
  const [addBusy, setAddBusy] = useState(false);   // request in flight
  const [addErr, setAddErr]   = useState(null);    // inline error in the sheet
  const [addNote, setAddNote] = useState(null);    // success toast
  const libRef  = useRef(null); // scroll target: empty slot / SHOP empty → bibliotheek
  const mainRef = useRef(null); // the mode scroll pane — reset scroll on mode switch
  const searchRef = useRef(null); // desktop '/': focus the library search

  // Desktop-only keyboard: '/' focuses search, S / K flips the side panel.
  // Attached only when wide, so the phone gets zero new listeners.
  useEffect(() => {
    if (!wide) return;
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const tag = ((t && t.tagName) || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || (t && t.isContentEditable)) return;
      if (e.key === "/") { e.preventDefault(); if (searchRef.current) searchRef.current.focus(); }
      else if (e.key === "s" || e.key === "S") setDeskSide("shop");
      else if (e.key === "k" || e.key === "K") setDeskSide("cook");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide]);

  // Load the corpus. API first (server falls back corpus → seed itself); the
  // inline set is the last resort so the shell is never blank even if the
  // server is down (source 'offline' = error state).
  useEffect(() => {
    let alive = true;
    API_GET("/api/recipes")
      .then(d => { if (!alive) return; setRecipes(d.recipes || []); setSource(d.source || ""); })
      .catch(() => { if (!alive) return; setRecipes(FALLBACK_RECIPES); setSource("offline"); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Each mode is its own page — start it at the top.
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [mode]);

  // Prune persisted plan entries whose recipe no longer exists — but ONLY against
  // the real corpus. The 2-recipe offline fallback would false-positive and wipe
  // a valid saved plan, so an offline boot keeps the plan untouched.
  useEffect(() => {
    if (!loaded || source === "offline" || !recipes.length) return;
    setSelected(prev => {
      const next = prev.filter(id => recipes.some(r => r.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [loaded, source, recipes]);

  const byId = useCallback(id => recipes.find(r => r.id === id), [recipes]);

  // Precompute each recipe's main-ingredient category once (id → meat/fish/…).
  const catById = useMemo(() => {
    const m = new Map();
    recipes.forEach(r => m.set(r.id, categoryOf(r)));
    return m;
  }, [recipes]);

  // Tag filter chips — union of every recipe tag, plus ALL.
  const tags = useMemo(() => {
    const s = new Set();
    recipes.forEach(r => (r.tags || []).forEach(t => s.add(t)));
    return ["all", ...[...s].sort()];
  }, [recipes]);

  // Visible library list: not removed → category → tag → keyword → time (all AND).
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipes.filter(r => {
      if (removedIds.has(r.id)) return false;
      if (cat !== "all" && catById.get(r.id) !== cat) return false;
      if (tag !== "all" && !(r.tags || []).includes(tag)) return false;
      if (q) {
        const hay = [r.title, r.subtitle, r.cuisine, ...(r.tags || []), ...((r.ingredients || []).map(i => i.name))]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (timeMax != null) {
        const t = Number(r.totalTime);
        if (r.totalTime == null || !Number.isFinite(t) || t > timeMax) return false;
      }
      return true;
    });
  }, [recipes, removedIds, cat, catById, tag, search, timeMax]);

  // The weekly plan is a LIST, not a set — the same dish may fill several
  // compartments (cook the same dinner two days). Order = pick order = day slot.
  const countOf = useCallback(id => selected.filter(x => x === id).length, [selected]);

  function addToPlan(id) {
    setSelected(prev => (prev.length >= MAX_DINNERS ? prev : [...prev, id])); // cap at 5 dinners
  }
  // Remove ONE instance — the exact compartment (by index) or the last-added of an id.
  function removeAt(index) {
    setSelected(prev => prev.filter((_, i) => i !== index));
  }
  function removeOneOf(id) {
    setSelected(prev => {
      const i = prev.lastIndexOf(id);
      return i === -1 ? prev : prev.filter((_, k) => k !== i);
    });
  }

  // ── Weekrandomizer — "verras me" ────────────────────────────────────────────
  // Fills the whole week (MA–ZO) with SIX random distinct recipes: five days get
  // their own dish, and DINSDAG's dish is repeated WOENSDAG (cook once, eat
  // twice). That is 6 recipes over 7 dinners. Picks from the live library minus
  // any card the user soft-removed. With fewer than six recipes available it
  // fills leading days only (staying dense — no holes to break persistence) and
  // still doubles DI→WO whenever there are at least two dishes to work with.
  const shuffleWeek = useCallback(() => {
    const pool = recipes.filter(r => !removedIds.has(r.id));
    if (pool.length === 0) {
      setRemoveNote("Nog geen recepten om uit te kiezen — vul eerst je bibliotheek. 🍙");
      setTimeout(() => setRemoveNote(null), 3500);
      return;
    }
    // Fisher–Yates over a copy, then take up to six distinct recipes.
    const bag = pool.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const pick = bag.slice(0, 6).map(r => r.id);
    // Lay the picks across the seven day slots (DI==WO). Stop as soon as a slot
    // would need a recipe we don't have, so the plan array never holds a hole.
    const week = [];
    for (const idx of RANDOM_DAY_PICKS) {
      if (pick[idx] == null) break;
      week.push(pick[idx]);
    }
    setSelected(week);
    setHeroIdx(null); // let "vanavond" resolve to today again
  }, [recipes, removedIds]);

  // Soft-remove a recipe card: optimistic drop, POST to persist (keep:false on its
  // corpus file), restore + a gentle note if the request fails.
  async function handleRemove(r) {
    setRemovedIds(prev => { const n = new Set(prev); n.add(r.id); return n; });
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(r.id)}/remove`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setRemovedIds(prev => { const n = new Set(prev); n.delete(r.id); return n; });
      setRemoveNote(`Kon "${r.title}" niet verwijderen: kaartje teruggezet.`);
      setTimeout(() => setRemoveNote(null), 3500);
    }
  }

  // Persist an edited ingredient list (swap / add / remove a line) for one recipe.
  // Optimistic: patch the in-memory corpus (so the shopping list + card re-render
  // at once) and the open sheet, then PUT to write the corpus file. On failure we
  // roll both back to their previous ingredients and rethrow so the sheet can
  // surface the error and keep the user in edit mode. Quantities are BASE amounts
  // (per recipe.servings) — the shopping list scales them per the porties setting.
  const handleSaveIngredients = useCallback(async (id, ingredients) => {
    const prev = (recipes.find(r => r.id === id) || {}).ingredients || [];
    setRecipes(rs => rs.map(r => (r.id === id ? { ...r, ingredients } : r)));
    setDetail(d => (d && d.id === id ? { ...d, ingredients } : d));
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(id)}/ingredients`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch (e) {
      setRecipes(rs => rs.map(r => (r.id === id ? { ...r, ingredients: prev } : r)));
      setDetail(d => (d && d.id === id ? { ...d, ingredients: prev } : d));
      throw e;
    }
  }, [recipes]);

  // Add a recipe from a pasted URL: POST to the server (schema.org JSON-LD →
  // corpus JSON), then splice the normalized recipe straight into the library so
  // it shows without a reload. A re-add un-hides a previously soft-removed card.
  async function handleAddFromUrl(e) {
    if (e && e.preventDefault) e.preventDefault();
    const url = addUrl.trim();
    if (!url || addBusy) return;
    setAddBusy(true);
    setAddErr(null);
    try {
      const res = await fetch("/api/recipes/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.recipe) throw new Error(data.error || "toevoegen mislukt");
      const recipe = data.recipe;
      setRecipes(prev => [recipe, ...prev.filter(r => r.id !== recipe.id)]);
      setRemovedIds(prev => {
        if (!prev.has(recipe.id)) return prev;
        const n = new Set(prev); n.delete(recipe.id); return n;
      });
      setAddUrl("");
      setAddOpen(false);
      setAddNote(`"${recipe.title}" toegevoegd 🍱`);
      setTimeout(() => setAddNote(null), 3500);
    } catch (err) {
      setAddErr(err.message || "toevoegen mislukt");
    } finally {
      setAddBusy(false);
    }
  }

  // ── Aggregated shopping list ──────────────────────────────────────────────
  // For every selected recipe, scale each ingredient by servings/recipe.servings,
  // then dedupe by name+unit (unit-aware). Different units for the same name stay
  // as separate lines. Sorted alphabetically by name.
  const shoppingList = useMemo(() => {
    const acc = new Map();
    selected.forEach((id, slot) => {
      const r = byId(id);
      if (!r) return;
      const scale = servings / (r.servings || servings || 1);
      for (const ing of r.ingredients || []) {
        const name = (ing.name || "").trim();
        const unit = (ing.unit || "").trim();
        if (!name) continue;
        const key = `${name.toLowerCase()}__${unit.toLowerCase()}`;
        const add = (Number(ing.qty) || 0) * scale;
        if (acc.has(key)) {
          const cur = acc.get(key);
          cur.qty += add;
          cur.from += 1;
          if (!cur.days.includes(slot)) cur.days.push(slot); // which weekmenu day needs it
        } else {
          acc.set(key, { name, unit, qty: add, from: 1, days: [slot] });
        }
      }
    });
    return [...acc.values()].sort((a, b) => a.name.localeCompare(b.name, "nl"));
  }, [selected, servings, byId]);

  // Walk-ordered route over the CURRENT list — powers the SHOP checklist, the
  // paw-print trail and the floorplan sheet (one shared engine).
  const route = useMemo(() => buildRoute(shoppingList, STORE), [shoppingList]);
  const toggleAisle = useCallback(key => {
    setAisleChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);
  const checkedCount = useMemo(
    () => shoppingList.filter(it => aisleChecked.has(keyOf(it))).length,
    [shoppingList, aisleChecked]
  );
  const allDone = shoppingList.length > 0 && checkedCount === shoppingList.length;

  // Week frame (MA..ZO of the current week) + the "vanavond" hero slot.
  // Slot i of the plan = weekday i (MA..VR); hero = today's slot if filled,
  // else the first filled slot; "Recept wisselen" pins the next one.
  const { todayIdx, days: weekDays, week: weekNr } = useMemo(() => weekInfo(), []);
  const autoHero = selected[todayIdx] != null ? todayIdx : (selected.length ? 0 : -1);
  const hIdx = heroIdx != null && heroIdx < selected.length ? heroIdx : autoHero;
  const heroRecipe = hIdx >= 0 ? byId(selected[hIdx]) : null;
  const heroT = heroRecipe ? cookTiming(heroRecipe) : null;

  // Aggregate week stats for the PLAN summary (times + eiwitbalans).
  const weekStats = useMemo(() => {
    let total = 0, active = 0;
    const cats = { meat: 0, chicken: 0, fish: 0, veg: 0 };
    for (const id of selected) {
      const r = byId(id);
      if (!r) continue;
      const t = cookTiming(r);
      total += t.total; active += t.active;
      cats[catById.get(id) || "veg"] += 1;
    }
    return { total, active, cats };
  }, [selected, byId, catById]);

  // Cross-mode jump: SHOP/KOOK empty states send you to the PLAN bibliotheek.
  const goPlanLibrary = useCallback(() => {
    setMode("plan");
    setTimeout(() => { libRef.current && libRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
  }, []);

  const PANE = { maxWidth: 560, margin: "0 auto", padding: "18px 16px 30px",
    display: "flex", flexDirection: "column", gap: 18, animation: "ichFade .3s ease" };
  // Desk column inner pane — same rhythm as PANE, but the column IS the width.
  const DESK_PANE = { padding: "18px 18px 30px",
    display: "flex", flexDirection: "column", gap: 18, animation: "ichFade .3s ease" };

  const loadingCard = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "56px 0", color: G_MUTED }}>
      <Mascot type="matcha" size={78} />
      <span style={{ fontSize: 15, fontWeight: 700 }}>Matcha-kun haalt de recepten op…</span>
    </div>
  );

  /* ═══════════════════ 献 PLAN — the couch job ═══════════════════
     Split into named pieces so the phone page (stacked, unchanged order) and
     the desktop desk (three columns) compose the SAME JSX — one source each. */
  function renderOffline() {
    if (source !== "offline") return null;
    return (
          <div role="status" style={{ background: "#FFF5DE", color: "#C58A16", fontSize: 13, fontWeight: 700,
            borderRadius: R_MD, padding: "10px 14px", boxShadow: SHADOW_SOFT, lineHeight: 1.55 }}>
            📡 Offline — de bibliotheek is niet bereikbaar, je ziet een mini-set. Je weekplan en vinkjes blijven bewaard.
          </div>
    );
  }

  // vanavond shortcut → 火 KOOK (on the desk it also flips the side panel)
  function renderTonight() {
    if (!heroRecipe || !heroT) return null;
    return (
          <button className="kg-ich-btn" onClick={() => { setMode("cook"); setDeskSide("cook"); }}
            style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", width: "100%",
              background: CARD, border: "none", borderRadius: R_LG, padding: "12px 14px", boxShadow: SHADOW_SOFT }}>
            <span style={{ fontSize: 27, flexShrink: 0 }}>{cuisineOf(heroRecipe.cuisine).emoji}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 10.5, fontWeight: 800, letterSpacing: "0.24em", color: SAKURA_DP }}>
                今夜 · VANAVOND
              </span>
              <span className="kg-ich-clamp1" style={{ display: "block", fontSize: 14.5, fontWeight: 800, color: INK, lineHeight: 1.35 }}>
                {heroRecipe.title}
              </span>
            </span>
            <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 800, color: "#fff", background: SAKURA,
              borderRadius: R_PILL, padding: "8px 13px", whiteSpace: "nowrap", boxShadow: "0 6px 14px rgba(242,109,139,.3)" }}>
              🔥 Kook · {heroT.total}′
            </span>
          </button>
    );
  }

  // week bento rail — 7 days; phone: snap-scroll strip, desk: vertical board
  function renderWeekRail() {
    return (
        <section>
          <SecTag k="献" label="Weekmenu" right={`WEEK ${weekNr} · ${fmtD(weekDays[0])} - ${fmtD(weekDays[6])}`} />
          {/* weekrandomizer — vult MA–ZO met 6 recepten (DI-gerecht draait door naar WO) */}
          <button className="kg-ich-btn" onClick={shuffleWeek} disabled={!loaded || recipes.length === 0}
            aria-label="Verras me — vul de hele week met willekeurige recepten"
            style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
              marginBottom: 12, border: "none", borderRadius: R_LG, padding: "12px 15px",
              background: `linear-gradient(150deg, ${SAKURA}, ${AZUKI})`, color: "#fff",
              boxShadow: "0 8px 18px rgba(214,91,120,.34)", cursor: (!loaded || recipes.length === 0) ? "not-allowed" : "pointer",
              opacity: (!loaded || recipes.length === 0) ? 0.55 : 1 }}>
            <span className="kg-ich-dice" aria-hidden="true" style={{ fontSize: 26, flexShrink: 0 }}>🎲</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 10.5, fontWeight: 800, letterSpacing: "0.22em", opacity: 0.9 }}>
                お任せ · VERRAS ME
              </span>
              <span style={{ display: "block", fontSize: 14.5, fontWeight: 800, lineHeight: 1.3 }}>
                Vul mijn week — 6 recepten
              </span>
            </span>
            <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 800, lineHeight: 1.35, textAlign: "right",
              background: "rgba(255,255,255,.22)", borderRadius: R_MD, padding: "6px 9px" }}>
              DI + WO<br />zelfde gerecht
            </span>
          </button>
          <div className="kg-ich-rail" role="list" aria-label={`Weekmenu met ${selected.length} van ${MAX_DINNERS} geplande diners`}>
            {weekDays.map((d, i) => {
              const isToday = i === todayIdx;
              const dnum = String(d.getDate()).padStart(2, "0");
              const dayHead = (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.16em", color: isToday ? SAKURA_DP : undefined }}>
                    {DAY_ABBR[i]}{isToday ? " · VANDAAG" : ""}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{dnum}</span>
                </span>
              );
              const id = selected[i];
              const r = id ? byId(id) : null;
              if (!r) {
                const firstEmpty = i === selected.length; // the next slot to fill
                return (
                  <button key={i} role="listitem" className="kg-ich-btn"
                    onClick={() => libRef.current && libRef.current.scrollIntoView({ behavior: "smooth", block: "start" })}
                    style={{ minHeight: 150, borderRadius: R_MD, border: `2px dashed ${firstEmpty ? SAKURA : G_LINE}`,
                      background: "transparent", padding: "12px 12px", display: "flex", flexDirection: "column", gap: 8,
                      color: firstEmpty ? SAKURA_DP : G_MUTED, textAlign: "left" }}>
                    {dayHead}
                    <span style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, width: "100%" }}>
                      <span style={{ fontSize: 22, lineHeight: 1 }}>＋</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{firstEmpty ? "kies een gerecht" : "leeg"}</span>
                    </span>
                  </button>
                );
              }
              const c = catById.get(id) || "veg";
              const cz = cuisineOf(r.cuisine);
              const time = r.totalTime || r.prepTime;
              // Woensdag serving Dinsdag's dish again → leftovers (1× koken, 2× eten).
              const isLeftover = i === LEFTOVER_TO && selected[LEFTOVER_FROM] === id;
              return (
                <article key={i} role="listitem" className="kg-ich-day" onClick={() => setDetail(r)}
                  style={{ position: "relative", minHeight: 150, background: CARD, borderRadius: R_MD, padding: "12px 12px 10px",
                    display: "flex", flexDirection: "column", gap: 7, cursor: "pointer",
                    boxShadow: i === hIdx ? `0 0 0 3px ${SAKURA}, ${SHADOW_SOFT}` : SHADOW_SOFT }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 20, color: "#C7A98F" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.16em", color: isToday ? SAKURA_DP : INK_SOFT }}>
                      {DAY_ABBR[i]}{isToday ? " · VANDAAG" : ""}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{dnum}</span>
                  </div>
                  <div className="kg-ich-clamp" style={{ fontSize: 13.5, fontWeight: 800, color: INK, lineHeight: 1.3, flex: "0 0 auto" }}>
                    {cz.emoji} {r.title}
                  </div>
                  <div className="kg-ich-clamp" style={{ fontSize: 11.5, color: INK_SOFT, lineHeight: 1.5, flex: 1 }}>
                    {(r.ingredients || []).slice(0, 3).map(x => (x.name || "").toLowerCase()).join(" · ")}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.14em", color: CAT_META[c].fg }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: CAT_META[c].bar, flexShrink: 0 }} />
                    {CAT_META[c].label}{time ? ` · ${time}′` : ""}
                  </div>
                  {isLeftover && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start",
                      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.1em", color: RAMUNE_DP,
                      background: "#E4F3F5", borderRadius: R_PILL, padding: "3px 8px" }}>
                      ♻ RESTJE VAN DI
                    </span>
                  )}
                  <button className="kg-ich-btn" aria-label={`"${r.title}" uit het weekmenu`}
                    onClick={e => { e.stopPropagation(); removeAt(i); }}
                    style={{ position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: "50%",
                      border: "none", background: "#FFE9EC", color: AZUKI, fontSize: 14, lineHeight: 1,
                      fontWeight: 800, boxShadow: "0 2px 5px rgba(214,91,120,.28)" }}>×</button>
                </article>
              );
            })}
          </div>
        </section>
    );
  }

  // porties + bento meter + leegmaken
  function renderPorties() {
    return (
        <section style={{ background: CARD, borderRadius: R_LG, padding: "13px 16px", boxShadow: SHADOW_SOFT,
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, color: INK_SOFT, fontWeight: 800 }}>Porties</span>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <button className="kg-ich-btn" aria-label="minder porties" onClick={() => setServings(s => Math.max(1, s - 1))}
              style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: MATCHA, color: "#fff",
                fontSize: 19, fontWeight: 800, boxShadow: SHADOW_SOFT, lineHeight: 1 }}>–</button>
            <span style={{ fontSize: 18, fontWeight: 800, minWidth: "1.6ch", textAlign: "center", color: INK,
              fontVariantNumeric: "tabular-nums" }}>{servings}</span>
            <button className="kg-ich-btn" aria-label="meer porties" onClick={() => setServings(s => Math.min(12, s + 1))}
              style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: MATCHA, color: "#fff",
                fontSize: 19, fontWeight: 800, boxShadow: SHADOW_SOFT, lineHeight: 1 }}>+</button>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <BentoMeter filled={selected.length} cell={15} />
            {selected.length > 0 && (
              <button className="kg-ich-btn" onClick={() => setSelected([])}
                style={{ background: "#fff", border: `2px solid ${LINE}`, borderRadius: R_PILL,
                  color: INK_SOFT, fontSize: 12.5, fontWeight: 800, padding: "8px 12px" }}>
                Leegmaken
              </button>
            )}
          </div>
        </section>
    );
  }

  // week stats + eiwitbalans
  function renderWeekStats() {
    if (selected.length === 0) return null;
    return (
          <section style={{ background: RICE2, borderRadius: R_LG, padding: "16px 18px", boxShadow: SHADOW_SOFT }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.24em", textTransform: "uppercase", color: MATCHA_DP }}>均 · Deze week</span>
              <Mascot type="tamago" size={30} bob={false} style={{ marginLeft: "auto", marginTop: -4 }} />
            </div>
            {[
              ["DINERS", `${selected.length} / ${MAX_DINNERS}`],
              ["KOOKTIJD TOTAAL", fmtDur(weekStats.total)],
              ["HANDS-ON", fmtDur(weekStats.active)],
              ["BOODSCHAPPEN", `${shoppingList.length} items`],
            ].map(([l, v]) => (
              <div key={l} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${LINE}` }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: INK_SOFT }}>{l}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>{v}</span>
              </div>
            ))}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: INK_SOFT }}>EIWITBALANS</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: INK_SOFT }}>{selected.length} {selected.length === 1 ? "avond" : "avonden"}</span>
              </div>
              <div style={{ display: "flex", height: 9, borderRadius: R_PILL, overflow: "hidden", background: "#F3E6D6", marginTop: 8 }}>
                {["meat", "chicken", "fish", "veg"].map(k => weekStats.cats[k] > 0 && (
                  <span key={k} style={{ flex: weekStats.cats[k], background: CAT_META[k].bar }} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 9 }}>
                {["meat", "chicken", "fish", "veg"].map(k => (
                  <span key={k} style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.12em", color: CAT_META[k].fg, display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: CAT_META[k].bar }} />
                    {CAT_META[k].label} {weekStats.cats[k]}
                  </span>
                ))}
              </div>
            </div>
          </section>
    );
  }

  // receptenbibliotheek — big tap rows + de bewaarde filters
  function renderLibrary() {
    return (
        <section ref={libRef} style={{ scrollMarginTop: 12 }}>
          <SecTag k="皿" label="Bibliotheek" right={loaded ? `${shown.length} RECEPTEN` : "LADEN…"} />
          <p style={{ fontSize: 13, color: G_MUTED, margin: "0 0 12px", lineHeight: 1.6 }}>
            Kies tot {MAX_DINNERS} diners voor je week (hetzelfde gerecht mag meerdere dagen). 🍱
          </p>

          {/* add a recipe straight from a link — opens the URL sheet */}
          <button className="kg-ich-btn" onClick={() => { setAddErr(null); setAddOpen(true); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
              minHeight: 48, marginBottom: 12, background: "#fff", border: `2px dashed ${MATCHA}`,
              borderRadius: R_LG, color: MATCHA_DP, fontFamily: F_DISPLAY, fontSize: 14.5, fontWeight: 800,
              boxShadow: SHADOW_SOFT }}>
            <span style={{ fontSize: 17, lineHeight: 1 }}>＋</span> Recept via URL
          </button>

          {/* keyword search */}
          <div style={{ position: "relative", marginBottom: 12 }}>
            <span aria-hidden="true" style={{ position: "absolute", left: 16, top: "50%",
              transform: "translateY(-50%)", fontSize: 15, pointerEvents: "none" }}>🔍</span>
            <input type="text" className="kg-ich-search-input" ref={searchRef} value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Zoek op naam, ingrediënt of tag…" />
            {search && (
              <button className="kg-ich-btn" onClick={() => setSearch("")} aria-label="zoekopdracht wissen"
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  width: 34, height: 34, borderRadius: "50%", border: "none", background: "transparent",
                  color: INK_SOFT, fontSize: 15, lineHeight: 1 }}>
                ✕
              </button>
            )}
          </div>

          {/* soort (main-ingredient) chips */}
          <div className="kg-ich-chiprow" role="group" aria-label="filter op soort">
            {CATEGORY_FILTERS.map(c => {
              const on = cat === c.key;
              return (
                <button key={c.key} className="kg-ich-chip" onClick={() => setCat(c.key)} aria-pressed={on}
                  style={{ background: on ? SAKURA : "#fff", border: "none", borderRadius: R_PILL,
                    color: on ? "#fff" : INK_SOFT, fontSize: 13.5, fontWeight: 800, padding: "9px 15px",
                    whiteSpace: "nowrap", flexShrink: 0,
                    boxShadow: on ? "0 6px 14px rgba(242,109,139,.30)" : SHADOW_SOFT }}>
                  {c.emoji ? `${c.emoji} ${c.label}` : c.label}
                </button>
              );
            })}
          </div>

          {/* tijd chips */}
          <div className="kg-ich-chiprow" role="group" aria-label="filter op bereidingstijd">
            <span style={{ fontSize: 12.5, fontWeight: 800, color: G_MUTED, alignSelf: "center", flexShrink: 0 }}>⏱</span>
            {TIME_BUCKETS.map(b => {
              const on = timeMax === b.max;
              return (
                <button key={b.key} className="kg-ich-chip" onClick={() => setTimeMax(b.max)} aria-pressed={on}
                  style={{ background: on ? MATCHA : "#fff", border: "none", borderRadius: R_PILL,
                    color: on ? "#fff" : INK_SOFT, fontSize: 13.5, fontWeight: 800, padding: "9px 15px",
                    whiteSpace: "nowrap", flexShrink: 0,
                    boxShadow: on ? "0 6px 14px rgba(95,174,119,.30)" : SHADOW_SOFT }}>
                  {b.label}
                </button>
              );
            })}
          </div>

          {/* tag chips */}
          {tags.length > 1 && (
            <div className="kg-ich-chiprow" role="group" aria-label="filter op tag" style={{ marginBottom: 10 }}>
              {tags.map(t => {
                const on = tag === t;
                return (
                  <button key={t} className="kg-ich-chip" onClick={() => setTag(t)} aria-pressed={on}
                    style={{ background: on ? SAKURA : "#fff", border: "none", borderRadius: R_PILL,
                      color: on ? "#fff" : INK_SOFT, fontSize: 13.5, fontWeight: 800, padding: "9px 15px",
                      whiteSpace: "nowrap", flexShrink: 0,
                      boxShadow: on ? "0 6px 14px rgba(242,109,139,.30)" : SHADOW_SOFT }}>
                    {t === "all" ? "Alle" : t}
                  </button>
                );
              })}
            </div>
          )}

          {!loaded && loadingCard}
          {loaded && shown.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "48px 0", color: G_MUTED }}>
              <Mascot type="onigiri" size={72} bob={false} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>Geen recepten gevonden 🍙</span>
            </div>
          )}

          {/* recipe rows — whole row taps; + / stepper on the thumb side.
              (.kg-ich-lib-list: the desk regrids this into recipe cards) */}
          <div className="kg-ich-lib-list" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {loaded && shown.map(r => {
              const count  = countOf(r.id);
              const inPlan = count > 0;
              const full   = selected.length >= MAX_DINNERS;
              const cz     = cuisineOf(r.cuisine);
              const time   = r.totalTime || r.prepTime;
              const c      = catById.get(r.id) || "veg";
              return (
                <article key={r.id} className="kg-ich-card"
                  style={{ display: "flex", alignItems: "center", gap: 12, background: CARD, borderRadius: R_LG,
                    padding: "10px 12px", minHeight: 78,
                    boxShadow: inPlan ? `0 0 0 3px ${SAKURA}, ${SHADOW_SOFT}` : SHADOW_SOFT }}>
                  {/* thumb — real photo falls back to the pastel emoji tile */}
                  <div onClick={() => setDetail(r)} style={{ position: "relative", width: 58, height: 58, flexShrink: 0,
                    borderRadius: R_MD, overflow: "hidden", cursor: "pointer",
                    background: `linear-gradient(150deg, ${cz.a}, ${cz.b})`,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 30 }}>{cz.emoji}</span>
                    {r.image && (
                      <img src={r.image} alt="" loading="lazy"
                        onError={e => { e.currentTarget.style.display = "none"; }}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                    )}
                  </div>
                  {/* title + meta — taps open the recipe sheet */}
                  <div onClick={() => setDetail(r)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                    <div className="kg-ich-clamp kg-ich-title" style={{ fontFamily: F_DISPLAY, fontSize: 14.5, fontWeight: 800, color: INK, lineHeight: 1.3 }}>
                      {r.title}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 800,
                      letterSpacing: "0.12em", marginTop: 4, color: CAT_META[c].fg }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: CAT_META[c].bar, flexShrink: 0 }} />
                      {CAT_META[c].label}{time ? ` · ⏱ ${time}′` : ""}
                    </div>
                  </div>
                  {/* controls: + (or [− n +]) with the library-remove ghost under it */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flexShrink: 0 }}>
                    {inPlan ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 5, background: SAKURA,
                        borderRadius: R_PILL, padding: "4px 6px", boxShadow: SHADOW_SOFT }}>
                        <button className="kg-ich-btn" onClick={() => removeOneOf(r.id)}
                          title="Eén dag minder" aria-label={`Eén "${r.title}" uit bento`}
                          style={{ width: 30, height: 30, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.9)",
                            color: AZUKI, fontSize: 18, fontWeight: 800, lineHeight: 1, cursor: "pointer" }}>–</button>
                        <span style={{ minWidth: "1.2ch", textAlign: "center", color: "#fff", fontSize: 14, fontWeight: 800,
                          fontVariantNumeric: "tabular-nums" }}>{count}</span>
                        <button className="kg-ich-btn" onClick={() => addToPlan(r.id)} disabled={full}
                          title={full ? `Max ${MAX_DINNERS} diners` : "Nog een dag"} aria-label={`Nog een "${r.title}" in bento`}
                          style={{ width: 30, height: 30, borderRadius: "50%", border: "none",
                            background: full ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.9)",
                            color: full ? "#D8907F" : SAKURA_DP, fontSize: 18, fontWeight: 800, lineHeight: 1,
                            cursor: full ? "not-allowed" : "pointer" }}>+</button>
                      </div>
                    ) : (
                      <button className="kg-ich-btn" onClick={() => addToPlan(r.id)} disabled={full}
                        title={full ? `Max ${MAX_DINNERS} diners` : "In m'n bento"} aria-label={`"${r.title}" in m'n bento`}
                        style={{ width: 44, height: 44, borderRadius: "50%",
                          border: "none", background: "#fff",
                          color: full ? "#D8C4B0" : SAKURA_DP, fontSize: 22, lineHeight: 1, fontWeight: 800,
                          boxShadow: SHADOW_SOFT, cursor: full ? "not-allowed" : "pointer", opacity: full ? 0.6 : 1 }}>
                        +
                      </button>
                    )}
                    <button className="kg-ich-btn" onClick={() => handleRemove(r)}
                      title="Uit de bibliotheek" aria-label={`"${r.title}" verwijderen uit de bibliotheek`}
                      style={{ width: 24, height: 24, borderRadius: "50%", border: "none",
                        background: "#FFE9EC", color: AZUKI, fontSize: 12, fontWeight: 800, lineHeight: 1,
                        opacity: 0.65, boxShadow: "0 2px 5px rgba(214,91,120,.2)" }}>×</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
    );
  }

  // The phone PLAN page — the pieces stacked exactly as before.
  function renderPlan() {
    return (
      <div style={PANE}>
        {renderOffline()}
        {renderTonight()}
        {renderWeekRail()}
        {renderPorties()}
        {renderWeekStats()}
        {renderLibrary()}
      </div>
    );
  }

  /* ═══════════════════ 買 SHOP — the aisle job ═══════════════════ */
  function renderShop() {
    const total = shoppingList.length;
    return (
      <div style={PANE}>
        <SecTag k="買" label="Boodschappen" right={total ? `${checkedCount} / ${total} BINNEN` : "JUMBO GENT"} />
        {!loaded ? loadingCard : total === 0 ? (
          <div style={{ background: CARD, borderRadius: R_LG, padding: "36px 20px", boxShadow: SHADOW_SOFT,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", color: INK_SOFT }}>
            <Mascot type="cat" size={72} />
            <span style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.6, maxWidth: "34ch" }}>
              Je lijst is nog leeg. Vul eerst het weekmenu, dan sorteert de scout je boodschappen per gang. 🐾
            </span>
            <button className="kg-ich-btn" onClick={goPlanLibrary}
              style={{ background: SAKURA, border: "none", borderRadius: R_PILL, color: "#fff",
                fontSize: 14.5, fontWeight: 800, minHeight: 48, padding: "12px 22px", boxShadow: SHADOW_SOFT }}>
              献 Naar je weekplan
            </button>
          </div>
        ) : (
          <>
            {/* paw-print trail — the scout's route; a done aisle earns a stamp */}
            <section style={{ background: CARD, borderRadius: R_LG, padding: "14px 12px 10px", boxShadow: SHADOW_SOFT }}>
              <div className="kg-ich-trail" role="list" aria-label="Looproute door de winkel">
                <span role="listitem" style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: INK_SOFT,
                  border: `2px dashed ${LINE}`, borderRadius: R_PILL, padding: "6px 11px", whiteSpace: "nowrap" }}>🚪 INGANG</span>
                {route.stops.map((s, i) => {
                  const done = s.items.every(it => aisleChecked.has(keyOf(it)));
                  return (
                    <span key={s.zone.id} role="listitem" style={{ display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                      <Paw size={12} color={done ? SAKURA_DP : "#E4CDB6"} />
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 800,
                        letterSpacing: "0.05em", whiteSpace: "nowrap", borderRadius: R_PILL, padding: "6px 11px",
                        color: done ? "#fff" : INK, background: done ? MATCHA_DP : RICE,
                        boxShadow: done ? "0 5px 12px rgba(95,174,119,.34)" : SHADOW_SOFT }}>
                        <span style={{ color: done ? "rgba(255,255,255,.85)" : MATCHA_DP, fontVariantNumeric: "tabular-nums" }}>
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {s.zone.emoji} {s.zone.label}
                        {done && <Paw size={13} color="#fff" className="kg-ich-stamp" />}
                      </span>
                    </span>
                  );
                })}
                <Paw size={12} color={allDone ? SAKURA_DP : "#E4CDB6"} style={{ flexShrink: 0 }} />
                <span role="listitem" style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", whiteSpace: "nowrap",
                  color: allDone ? "#fff" : INK_SOFT, background: allDone ? SAKURA : "transparent",
                  border: allDone ? "2px solid transparent" : `2px dashed ${LINE}`,
                  borderRadius: R_PILL, padding: "6px 11px" }}>
                  🛒 KASSA{allDone ? " 🎉" : ""}
                </span>
              </div>
              <p style={{ fontSize: 12, color: INK_SOFT, margin: "8px 4px 4px", lineHeight: 1.55 }}>
                Gesorteerd op looprichting: vers eerst, diepvries als laatste. Eén rondje, geen teruglopen.
              </p>
              <button className="kg-ich-btn" onClick={() => setShowRoute(true)}
                style={{ width: "100%", marginTop: 6, background: `linear-gradient(150deg, ${SAKURA}, ${AZUKI})`,
                  color: "#fff", border: "none", borderRadius: R_PILL, fontSize: 14.5, fontWeight: 800,
                  minHeight: 48, padding: "12px 20px", boxShadow: "0 8px 18px rgba(214,91,120,.34)" }}>
                🗺️ Bekijk plattegrond · Jumbo Gent
              </button>
            </section>

            {/* walk-ordered checklist — 52px whole-row taps */}
            <section style={{ background: CARD, borderRadius: R_LG, padding: "16px 16px 12px", boxShadow: SHADOW_SOFT }}>
              {route.stops.map((s, i) => {
                const done = s.items.every(it => aisleChecked.has(keyOf(it)));
                return (
                  <div key={s.zone.id} style={{ marginBottom: i < route.stops.length - 1 ? 14 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: MATCHA_DP, fontVariantNumeric: "tabular-nums" }}>{String(i + 1).padStart(2, "0")}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: done ? MATCHA_DP : INK_SOFT }}>
                        {s.zone.emoji} {s.zone.label}
                      </span>
                      <span aria-hidden="true" style={{ flex: 1, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${LINE}, transparent)` }} />
                      {done
                        ? <Paw size={15} color={SAKURA_DP} className="kg-ich-stamp" />
                        : <span style={{ fontSize: 11.5, fontWeight: 800, color: "#C7A98F", fontVariantNumeric: "tabular-nums" }}>{s.items.length}×</span>}
                    </div>
                    {s.items.map((it, j) => {
                      const key = keyOf(it);
                      const on = aisleChecked.has(key);
                      return (
                        <label key={`${key}_${j}`} className={`kg-ich-gitem${on ? " kg-ich-gitem--on" : ""}`}>
                          <input type="checkbox" checked={on} onChange={() => toggleAisle(key)} />
                          <span className="kg-ich-gnm">{it.name}</span>
                          {it.days && it.days.length > 0 && (
                            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "#C58A16",
                              background: "#FFF5DE", borderRadius: R_PILL, padding: "2px 7px", whiteSpace: "nowrap" }}>
                              {it.days.map(dd => DAY_ABBR[dd] || "").filter(Boolean).join("·")}
                            </span>
                          )}
                          {it.qty ? (
                            <span style={{ fontSize: 13.5, fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                              {fmtQty(it.qty)} {it.unit}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.18em", color: INK_SOFT }}>
                  WEEKLIJST · {servings}P · JUMBO GENT
                </span>
                <span style={{ fontSize: 14, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>{checkedCount} / {total}</span>
              </div>
              <p style={{ fontSize: 12, color: INK_SOFT, margin: "8px 0 4px", lineHeight: 1.55 }}>
                Samengevoegd per ingrediënt (eenheid-bewust), geschaald naar {servings} porties. Vinkjes blijven bewaard — ook na een herlaad in de gang.
              </p>
              {checkedCount > 0 && (
                <button className="kg-ich-btn" onClick={() => setAisleChecked(new Set())}
                  style={{ width: "100%", marginTop: 6, background: "#fff", border: `2px solid ${LINE}`, borderRadius: R_PILL,
                    color: INK_SOFT, fontSize: 13.5, fontWeight: 800, minHeight: 44, padding: "10px 18px" }}>
                  🐾 Nieuwe ronde — vinkjes wissen
                </button>
              )}
            </section>

            {allDone && (
              <div style={{ background: CARD, borderRadius: R_LG, padding: "22px 20px", boxShadow: SHADOW_SOFT,
                display: "flex", alignItems: "center", gap: 14, animation: "ichPop .25s ease" }}>
                <Mascot type="cat" size={58} />
                <div>
                  <div style={{ fontFamily: F_DISPLAY, fontSize: 16, fontWeight: 800, color: MATCHA_DP }}>Ronde klaar! 🎉</div>
                  <div style={{ fontSize: 13, color: INK_SOFT, lineHeight: 1.55 }}>Alles binnen — de scout stempelt je kaart af en wandelt mee naar de kassa.</div>
                </div>
                <Paw size={26} color={SAKURA_DP} className="kg-ich-stamp" style={{ marginLeft: "auto", flexShrink: 0 }} />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  /* ═══════════════════ 火 KOOK — the stove job ═══════════════════ */
  function renderKook() {
    if (!loaded) return <div style={PANE}><SecTag k="火" label="Kookmodus" />{loadingCard}</div>;
    if (!heroRecipe || !heroT) {
      return (
        <div style={PANE}>
          <SecTag k="火" label="Kookmodus" />
          <div style={{ background: CARD, borderRadius: R_LG, padding: "36px 20px", boxShadow: SHADOW_SOFT,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", color: INK_SOFT }}>
            <Mascot type="onigiri" size={72} />
            <span style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.6, maxWidth: "34ch" }}>
              Nog geen diner gepland. Kies eerst een gerecht, dan staat het recept hier voor je klaar.
            </span>
            <button className="kg-ich-btn" onClick={goPlanLibrary}
              style={{ background: SAKURA, border: "none", borderRadius: R_PILL, color: "#fff",
                fontSize: 14.5, fontWeight: 800, minHeight: 48, padding: "12px 22px", boxShadow: SHADOW_SOFT }}>
              献 Naar je weekplan
            </button>
          </div>
        </div>
      );
    }
    const scale = servings / (heroRecipe.servings || servings || 1);
    return (
      <div style={PANE}>
        {/* tonight hero — facts + act/wait split */}
        <section style={{ position: "relative", background: CARD, borderRadius: R_LG, padding: "18px 18px 20px",
          boxShadow: SHADOW_SOFT, overflow: "hidden" }}>
          <span aria-hidden="true" style={{ position: "absolute", right: 8, top: -6, fontSize: 76, opacity: 0.13, pointerEvents: "none" }}>
            {cuisineOf(heroRecipe.cuisine).emoji}
          </span>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: SAKURA_DP, marginBottom: 8 }}>
            今夜 · {hIdx === todayIdx ? "Wat eten we vanavond" : "Gepland"} · {DAY_FULL[hIdx]} {fmtD(weekDays[hIdx])}
          </div>
          <h2 className="kg-ich-title" onClick={() => setDetail(heroRecipe)}
            style={{ fontFamily: F_DISPLAY, fontSize: 22, fontWeight: 800, color: INK, lineHeight: 1.25, margin: "0 0 6px" }}>
            {heroRecipe.title}
          </h2>
          {heroRecipe.subtitle && (
            <p style={{ fontSize: 13.5, color: INK_SOFT, lineHeight: 1.6, margin: "0 0 14px" }}>{heroRecipe.subtitle}</p>
          )}
          {/* facts row */}
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 16 }}>
            {[
              [`${heroT.total}′`, "TOTAAL"],
              [`${heroT.active}′`, "HANDS-ON"],
              [String(servings), "PORTIES"],
              [String((heroRecipe.ingredients || []).length), "INGREDIËNTEN"],
            ].map(([v, l]) => (
              <div key={l}>
                <div style={{ fontFamily: F_DISPLAY, fontSize: 21, fontWeight: 800, color: INK, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{v}</div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.18em", color: INK_SOFT, marginTop: 3 }}>{l}</div>
              </div>
            ))}
          </div>
          {/* actief vs wachten split bar */}
          <div role="img" aria-label={`${heroT.active} minuten actief, ${heroT.passive} minuten wachten`}
            style={{ display: "flex", gap: 3, height: 12, borderRadius: R_PILL, overflow: "hidden" }}>
            <span style={{ flex: heroT.active || 1, background: SAKURA }} />
            {heroT.passive > 0 && <span style={{ flex: heroT.passive, background: RAMUNE }} />}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em" }}>
            <span style={{ color: SAKURA_DP }}>
              <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: SAKURA, marginRight: 6, verticalAlign: "-1px" }} />
              ACTIEF {heroT.active}′
            </span>
            <span style={{ color: RAMUNE_DP }}>
              <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: RAMUNE, marginRight: 6, verticalAlign: "-1px" }} />
              WACHTEN {heroT.passive}′
            </span>
          </div>
          {heroT.tip && (
            <p style={{ margin: "13px 0 0", fontSize: 13, lineHeight: 1.6, color: INK_SOFT, borderLeft: `3px solid ${RAMUNE}`, paddingLeft: 12 }}>
              💡 {heroT.tip}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className="kg-ich-btn" onClick={() => setDetail(heroRecipe)}
              style={{ background: SAKURA, border: "none", borderRadius: R_PILL, color: "#fff",
                fontSize: 14, fontWeight: 800, minHeight: 44, padding: "10px 18px", boxShadow: SHADOW_SOFT }}>
              ▸ Receptkaart
            </button>
            {selected.length > 1 && (
              <button className="kg-ich-btn" onClick={() => setHeroIdx((hIdx + 1) % selected.length)}
                style={{ background: "#fff", border: `2px solid ${LINE}`, borderRadius: R_PILL,
                  color: INK_SOFT, fontSize: 14, fontWeight: 800, minHeight: 44, padding: "9px 16px" }}>
                Recept wisselen
              </button>
            )}
          </div>
        </section>

        {/* mise en place — scaled ingredients */}
        <section style={{ background: CARD, borderRadius: R_LG, padding: "16px 18px", boxShadow: SHADOW_SOFT }}>
          <SecTag onCard k="皿" label="Mise en place" right={`${servings} PORTIES`} />
          {(heroRecipe.ingredients || []).map((ing, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
              minHeight: 42, padding: "3px 0", borderBottom: `1px solid ${LINE}`, fontSize: 14 }}>
              <span style={{ fontWeight: 600, color: INK }}>{ing.name}</span>
              <span style={{ fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {fmtQty((Number(ing.qty) || 0) * scale)} {ing.unit}
              </span>
            </div>
          ))}
        </section>

        {/* per-phase step timeline */}
        <section style={{ background: CARD, borderRadius: R_LG, padding: "16px 18px", boxShadow: SHADOW_SOFT }}>
          <SecTag onCard k="火" label="Bereiding" right={`${heroT.steps.length} STAPPEN`} />
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {heroT.steps.map((s, i) => {
              const passive = s.mode === "passive";
              return (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 0",
                  borderBottom: i < heroT.steps.length - 1 ? `1px solid ${LINE}` : "none" }}>
                  <span style={{ flex: "0 0 auto", width: 28, height: 28, borderRadius: "50%", background: passive ? RAMUNE : SAKURA,
                    color: "#fff", fontWeight: 800, fontSize: 13.5, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{s.text}</span>
                  {s.minutes != null && (
                    <span style={{ flex: "0 0 auto", fontSize: 11.5, fontWeight: 800, padding: "4px 10px", borderRadius: R_PILL,
                      whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", letterSpacing: "0.06em",
                      background: passive ? "#E4F3F5" : "#FFE3EA", color: passive ? RAMUNE_DP : SAKURA_DP }}>
                      {passive ? "WACHT" : "ACTIEF"} {s.minutes}′
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <p style={{ fontSize: 12.5, color: INK_SOFT, margin: "10px 0 0", lineHeight: 1.6 }}>
            <b style={{ color: INK }}>Roze = handen bezig, blauw = je bent vrij.</b>
          </p>
        </section>
      </div>
    );
  }

  /* ═══════════════════ shell — header · mode pane · mode nav ═══════════════ */
  const shopLeft = shoppingList.length - checkedCount;
  const navBadge = {
    plan: selected.length ? `${selected.length}/${MAX_DINNERS}` : "",
    shop: shoppingList.length ? (shopLeft > 0 ? `${shopLeft} te gaan` : "✓ klaar") : "",
    cook: heroT ? `${heroT.total}′` : "",
  };

  return (
    <div className={wide ? "kg-ichikawa kg-ich--wide" : "kg-ichikawa"} data-kg-component="ichikawa-surface" data-kg-owner="kg"
      style={{ position: embedded ? "absolute" : "fixed", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden",
        background: G_BG,
        backgroundImage: `radial-gradient(${G_DOTS} 1.6px, transparent 1.7px)`,
        backgroundSize: "24px 24px",
        color: G_TEXT, fontFamily: F_ROUND, lineHeight: 1.5,
        WebkitFontSmoothing: "antialiased" }}>
      <style>{`
        /* Self-hosted (latin subset) for offline PWA — was a Google-Fonts @import. */
        @font-face{font-family:'Baloo 2';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/baloo2-400.woff2') format('woff2');}
        @font-face{font-family:'Baloo 2';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/baloo2-500.woff2') format('woff2');}
        @font-face{font-family:'Baloo 2';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/baloo2-600.woff2') format('woff2');}
        @font-face{font-family:'Baloo 2';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/baloo2-700.woff2') format('woff2');}
        @font-face{font-family:'Baloo 2';font-style:normal;font-weight:800;font-display:swap;src:url('/fonts/baloo2-800.woff2') format('woff2');}
        @font-face{font-family:'M PLUS Rounded 1c';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/mplus-rounded-1c-400.woff2') format('woff2');}
        @font-face{font-family:'M PLUS Rounded 1c';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/mplus-rounded-1c-500.woff2') format('woff2');}
        @font-face{font-family:'M PLUS Rounded 1c';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/mplus-rounded-1c-700.woff2') format('woff2');}
        @font-face{font-family:'M PLUS Rounded 1c';font-style:normal;font-weight:800;font-display:swap;src:url('/fonts/mplus-rounded-1c-800.woff2') format('woff2');}
        @keyframes ichFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes ichPop{from{opacity:0;transform:scale(0.94)}to{opacity:1;transform:scale(1)}}
        @keyframes ichBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        @keyframes ichSheet{from{transform:translateY(48px);opacity:.4}to{transform:translateY(0);opacity:1}}
        @keyframes ichStamp{0%{transform:scale(0) rotate(-24deg)}70%{transform:scale(1.3) rotate(8deg)}100%{transform:scale(1) rotate(0deg)}}
        .kg-ichikawa *{box-sizing:border-box;}
        .kg-ichikawa ::-webkit-scrollbar{width:7px;height:7px;}
        .kg-ichikawa ::-webkit-scrollbar-track{background:transparent;}
        .kg-ichikawa ::-webkit-scrollbar-thumb{background:${LINE};border-radius:7px;}
        .kg-ich-bob{animation:ichBob 4s ease-in-out infinite;transform-origin:center;}
        .kg-ich-stamp{animation:ichStamp .35s ease;}
        .kg-ich-card{transition:box-shadow .18s ease, transform .15s ease;}
        .kg-ich-btn{transition:transform .12s ease, filter .12s ease, background .15s ease, color .15s ease;cursor:pointer;font-family:inherit;}
        .kg-ich-btn:active{transform:scale(.95);}
        .kg-ich-btn:focus-visible{outline:3px solid ${RAMUNE};outline-offset:2px;}
        .kg-ich-chip{transition:transform .12s ease, filter .12s ease;cursor:pointer;font-family:inherit;}
        .kg-ich-chip:active{transform:scale(.95);}
        .kg-ich-day{transition:box-shadow .15s ease, transform .15s ease;}
        .kg-ich-dice{display:inline-block;transition:transform .2s ease;}
        .kg-ich-title{cursor:pointer;transition:color .15s ease;}
        .kg-ich-title:hover{color:${SAKURA_DP};}
        .kg-ich-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
        .kg-ich-clamp1{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}
        .kg-ich-search-input{width:100%;box-sizing:border-box;background:#fff;
          border:2px solid ${LINE};border-radius:${R_PILL}px;padding:12px 44px 12px 42px;min-height:48px;
          font-size:15px;font-family:inherit;color:${INK};box-shadow:${SHADOW_SOFT};outline:none;
          transition:border-color .15s ease, box-shadow .15s ease;}
        .kg-ich-search-input::placeholder{color:${INK_SOFT};}
        .kg-ich-search-input:focus{border-color:${MATCHA_DP};box-shadow:0 0 0 3px rgba(147,207,160,.28), ${SHADOW_SOFT};}
        /* week bento rail — 7 days, snap-scroll (one-thumb swipe) */
        .kg-ich-rail{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;
          padding:2px 2px 12px;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
        .kg-ich-rail::-webkit-scrollbar{display:none;}
        .kg-ich-rail>*{scroll-snap-align:center;flex:0 0 168px;min-width:168px;}
        /* horizontal chip strips (filters, paw trail) */
        .kg-ich-chiprow{display:flex;align-items:center;gap:8px;overflow-x:auto;padding:2px 2px 10px;
          -webkit-overflow-scrolling:touch;scrollbar-width:none;}
        .kg-ich-chiprow::-webkit-scrollbar{display:none;}
        .kg-ich-trail{display:flex;align-items:center;gap:7px;overflow-x:auto;padding:4px 4px 8px;
          -webkit-overflow-scrolling:touch;scrollbar-width:none;}
        .kg-ich-trail::-webkit-scrollbar{display:none;}
        /* grocery rows — 52px whole-row tap targets */
        .kg-ich-gitem{display:flex;align-items:center;gap:12px;min-height:52px;padding:4px 2px;cursor:pointer;}
        .kg-ich-gitem input{accent-color:${MATCHA_DP};width:22px;height:22px;flex-shrink:0;cursor:pointer;margin:0;}
        .kg-ich-gitem .kg-ich-gnm{flex:1;font-size:15px;font-weight:600;color:${INK};transition:color .15s ease;}
        .kg-ich-gitem--on .kg-ich-gnm{color:${INK_SOFT};text-decoration:line-through;text-decoration-color:#D9C3AC;}
        /* ── desktop desk — gated by the ONE JS breakpoint (WIDE_MQ) via the
           .kg-ich-desk / .kg-ich--wide classes; no second width lives here.
           The !importants below exist only to overrule the phone's inline
           styles from a desk-scoped class — never used outside .kg-ich-desk. */
        .kg-ich-desk{flex:1;min-height:0;display:grid;
          grid-template-columns:minmax(320px,430px) minmax(400px,1fr) minmax(340px,460px);}
        .kg-ich-desk-col{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;}
        .kg-ich-desk-col+.kg-ich-desk-col{border-left:1px solid ${G_LINE};}
        /* the phone's snap strip becomes a vertical week board — whole week visible */
        .kg-ich-desk .kg-ich-rail{flex-direction:column;overflow:visible;scroll-snap-type:none;}
        .kg-ich-desk .kg-ich-rail>*{flex:0 0 auto;width:100%;min-width:0;scroll-snap-align:none;min-height:118px!important;}
        /* filter strips + paw trail wrap instead of scrolling sideways */
        .kg-ich-desk .kg-ich-chiprow{flex-wrap:wrap;overflow-x:visible;}
        .kg-ich-desk .kg-ich-trail{flex-wrap:wrap;overflow-x:visible;row-gap:9px;}
        /* the library's tap rows regrid into recipe cards */
        .kg-ich-desk .kg-ich-lib-list{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));}
        /* bottom sheets become centered modals on the desk */
        .kg-ich--wide .kg-ich-overlay{align-items:center!important;padding:28px;}
        .kg-ich--wide .kg-ich-sheet{border-radius:${R_LG}px!important;max-height:88%!important;animation:ichPop .22s ease!important;}
        .kg-ich--wide .kg-ich-grab{display:none;}
        /* mouse affordances — hover-capable devices only, touch never sees them */
        @media(hover:hover){
          .kg-ich-card:hover,.kg-ich-day:hover{transform:translateY(-2px);}
          .kg-ich-btn:hover{filter:brightness(1.05);}
          .kg-ich-btn:hover .kg-ich-dice{transform:rotate(-18deg) scale(1.12);}
          .kg-ich-chip:hover{transform:translateY(-1px);}
          .kg-ich-gitem:not(.kg-ich-gitem--on):hover .kg-ich-gnm{color:${SAKURA_DP};}
        }
        @media(prefers-reduced-motion:reduce){.kg-ich-bob,.kg-ich-stamp{animation:none;}
          .kg-ich-card,.kg-ich-btn,.kg-ich-chip,.kg-ich-day{transition:none;}}
      `}</style>

      {/* ── compact header — kawaii wordmark, week stamp, scout, exit ── */}
      <header style={{ flexShrink: 0, position: "relative", zIndex: 2, display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px", borderBottom: `1px solid ${LINE}`,
        background: "linear-gradient(160deg,#FFFDFB,#FFF0E4)", boxShadow: SHADOW_SOFT }}>
        <span style={{ fontFamily: F_ROUND, fontSize: 27, fontWeight: 800, color: SAKURA,
          textShadow: "2px 2px 0 #FFE3EA", lineHeight: 0.9, flexShrink: 0 }}>市川</span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontFamily: F_DISPLAY, fontSize: 17, fontWeight: 800, letterSpacing: 0.4, color: INK, whiteSpace: "nowrap" }}>
              Ichi<span style={{ color: MATCHA_DP }}>kawa</span>
            </span>
            <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.2em", color: MATCHA_DP, flexShrink: 0,
              border: `2px solid ${MATCHA}`, borderRadius: R_PILL, padding: "1px 7px", background: "#fff" }}>
              PERSONAL
            </span>
          </div>
          <span className="kg-ich-clamp1" style={{ fontSize: 11, color: INK_SOFT, fontWeight: 600 }}>
            Market Scout · {loaded ? `${recipes.length} recepten` : "laden…"}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.14em", color: INK_SOFT, whiteSpace: "nowrap" }}>
            WEEK {weekNr}
          </span>
          <Mascot type="cat" size={38} />
          {onExit && (
            <button className="kg-ich-btn" onClick={onExit} aria-label="terug naar Kage-gumi" title="Terug naar Kage-gumi"
              style={{ width: 38, height: 38, borderRadius: "50%", background: "#fff", border: "none",
                color: MATCHA_DP, fontSize: 17, fontWeight: 800, lineHeight: 1, boxShadow: SHADOW_SOFT }}>
              ←
            </button>
          )}
        </div>
      </header>

      {wide ? (
        /* ── the management desk — plan · bibliotheek · shop/kook side panel ── */
        <div className="kg-ich-desk">
          {/* 献 plan column — build the week */}
          <div className="kg-ich-desk-col">
            <div style={DESK_PANE}>
              {renderOffline()}
              {renderTonight()}
              {renderWeekRail()}
              {renderPorties()}
              {renderWeekStats()}
            </div>
          </div>
          {/* 皿 bibliotheek column — curate the library */}
          <div className="kg-ich-desk-col">
            <div style={{ ...DESK_PANE, maxWidth: 760, margin: "0 auto", width: "100%" }}>
              {renderLibrary()}
            </div>
          </div>
          {/* 買/火 side panel — the execution jobs, previewed one at a time */}
          <aside className="kg-ich-desk-col" aria-label="Shop en kook paneel">
            <div style={{ position: "sticky", top: 0, zIndex: 3, display: "flex", gap: 8,
              padding: "12px 16px 10px", background: G_BG, borderBottom: `1px solid ${G_LINE}` }}>
              {[{ id: "shop", k: "買", label: "Shop", key: "S", badge: navBadge.shop },
                { id: "cook", k: "火", label: "Kook", key: "K", badge: navBadge.cook }].map(t => {
                const on = deskSide === t.id;
                return (
                  <button key={t.id} className="kg-ich-btn" onClick={() => setDeskSide(t.id)} aria-pressed={on}
                    title={`${t.label} — toets ${t.key}`}
                    style={{ flex: 1, minHeight: 42, borderRadius: R_PILL, border: "none",
                      background: on ? SAKURA : CARD, color: on ? "#fff" : INK_SOFT,
                      fontSize: 12.5, fontWeight: 800, letterSpacing: "0.08em", whiteSpace: "nowrap",
                      boxShadow: on ? "0 6px 14px rgba(242,109,139,.30)" : SHADOW_SOFT }}>
                    {t.k} {t.label.toUpperCase()}{t.badge ? ` · ${t.badge}` : ""}
                  </button>
                );
              })}
            </div>
            {deskSide === "cook" ? renderKook() : renderShop()}
          </aside>
        </div>
      ) : (
        /* ── mode pane — each mode is its own one-thumb page ── */
        <div ref={mainRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {mode === "plan" ? renderPlan() : mode === "shop" ? renderShop() : renderKook()}
        </div>
      )}

      {/* ── mode nav — thumb-reachable, persisted (phone only: the desk shows
             every job at once, so there is nothing to switch) ── */}
      {!wide && (
      <nav aria-label="Ichikawa modes" style={{ flexShrink: 0, position: "relative", zIndex: 2, display: "flex", gap: 8,
        padding: "9px 12px", paddingBottom: "max(9px, env(safe-area-inset-bottom))",
        background: CARD, borderTop: `1px solid ${LINE}`, boxShadow: "0 -6px 18px rgba(206,150,116,.14)" }}>
        {MODES.map(m => {
          const on = mode === m.id;
          const badge = navBadge[m.id];
          return (
            <button key={m.id} className="kg-ich-btn" onClick={() => setMode(m.id)} aria-pressed={on}
              style={{ flex: 1, minHeight: 56, borderRadius: R_MD, border: "none",
                background: on ? SAKURA : "transparent", color: on ? "#fff" : INK_SOFT,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                fontWeight: 800, boxShadow: on ? "0 8px 18px rgba(242,109,139,.32)" : "none" }}>
              <span style={{ fontSize: 19, lineHeight: 1 }}>{m.k}</span>
              <span style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                {m.label}{badge ? ` · ${badge}` : ""}
              </span>
            </button>
          );
        })}
      </nav>
      )}

      {/* ── toast — absolute child of the root (works in both mounts) ── */}
      {removeNote && (
        <div role="status" style={{ position: "absolute", left: 16, right: 16, bottom: 96, zIndex: 90,
          background: "#FFF0E6", color: SAKURA_DP, fontSize: 14, fontWeight: 700, textAlign: "center",
          borderRadius: R_MD, padding: "11px 16px", boxShadow: SHADOW_LIFT, animation: "ichPop .2s ease" }}>
          {removeNote}
        </div>
      )}

      {/* ── add-from-URL success toast (matcha) ── */}
      {addNote && (
        <div role="status" style={{ position: "absolute", left: 16, right: 16, bottom: 96, zIndex: 90,
          background: "#EAF7EE", color: MATCHA_DP, fontSize: 14, fontWeight: 700, textAlign: "center",
          borderRadius: R_MD, padding: "11px 16px", boxShadow: SHADOW_LIFT, animation: "ichPop .2s ease" }}>
          {addNote}
        </div>
      )}

      {/* ── add-a-recipe-from-URL sheet ── */}
      {addOpen && <AddUrlSheet url={addUrl} setUrl={setAddUrl} busy={addBusy} err={addErr}
        onSubmit={handleAddFromUrl} onClose={() => { if (!addBusy) { setAddOpen(false); setAddErr(null); } }} />}

      {/* ── recipe card sheet ── */}
      {detail && <RecipeSheet recipe={detail} servings={servings} count={countOf(detail.id)}
        canAdd={selected.length < MAX_DINNERS} onAdd={() => addToPlan(detail.id)}
        onRemoveOne={() => removeOneOf(detail.id)} onClose={() => setDetail(null)}
        onSaveIngredients={handleSaveIngredients} />}

      {/* ── store floorplan sheet — shares the persisted ticks with SHOP ── */}
      {showRoute && <RouteSheet items={shoppingList} servings={servings}
        checked={aisleChecked} onToggle={toggleAisle} onClose={() => setShowRoute(false)} />}
    </div>
  );
}

// ─── Recipe card sheet — bottom sheet with the full cooking-mode detail ──────
// position:absolute child of the root (NOT fixed) so it works identically in
// the desktop takeover and inside MobileShell's visualViewport-sized area.
function RecipeSheet({ recipe: r, servings, count, canAdd, onAdd, onRemoveOne, onClose, onSaveIngredients }) {
  // Ingredient editing — swap a line out, retune a quantity, or add a new one.
  // `draft` holds BASE quantities (per r.servings) as strings for controlled
  // inputs; null means "not editing". Save persists via the parent callback.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState("");
  const editing = draft !== null;

  useEffect(() => {
    // While editing, Escape cancels the edit instead of closing the whole sheet.
    const onKey = e => {
      if (e.key !== "Escape") return;
      if (draft !== null) { setDraft(null); setEditErr(""); }
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, draft]);

  const startEdit = () => {
    setEditErr("");
    setDraft((r.ingredients || []).map(i => ({
      name: i.name || "", qty: i.qty == null ? "" : String(i.qty), unit: i.unit || "",
    })));
  };
  const cancelEdit = () => { setDraft(null); setEditErr(""); };
  const setRow = (i, field, val) => setDraft(d => d.map((row, k) => (k === i ? { ...row, [field]: val } : row)));
  const removeRow = i => setDraft(d => d.filter((_, k) => k !== i));
  const addRow = () => setDraft(d => [...d, { name: "", qty: "", unit: "" }]);
  const saveEdit = async () => {
    const cleaned = draft
      .map(row => ({ name: row.name.trim(), qty: row.qty === "" ? null : Number(row.qty), unit: row.unit.trim() }))
      .filter(row => row.name && (row.qty === null || Number.isFinite(row.qty)));
    setSaving(true); setEditErr("");
    try {
      await onSaveIngredients(r.id, cleaned);
      setDraft(null);
    } catch {
      setEditErr("Opslaan mislukt — probeer opnieuw.");
    } finally {
      setSaving(false);
    }
  };

  const scale = servings / (r.servings || servings || 1);
  const cz = cuisineOf(r.cuisine);
  const inPlan = count > 0;
  const t = cookTiming(r);
  const activeFlex = t.active || 1;
  const passiveFlex = t.passive;

  return (
    <div onClick={onClose} className="kg-ich-overlay" style={{ position: "absolute", inset: 0, zIndex: 80, background: "rgba(75,59,66,.42)",
      display: "flex", alignItems: "flex-end", justifyContent: "center", animation: "ichFade .18s ease" }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={r.title} className="kg-ich-sheet"
        style={{ width: "100%", maxWidth: 560, maxHeight: "92%", background: CARD,
          borderRadius: `${R_LG}px ${R_LG}px 0 0`, overflow: "hidden", display: "flex", flexDirection: "column",
          animation: "ichSheet .22s ease", boxShadow: "0 -18px 60px rgba(150,110,80,.38)", fontFamily: F_ROUND, color: INK }}>
        {/* sheet header — pastel food banner + drag handle */}
        <div style={{ position: "relative", padding: "10px 20px 16px", background: `linear-gradient(150deg, ${cz.a}, ${cz.b})` }}>
          <div aria-hidden="true" className="kg-ich-grab" style={{ width: 44, height: 5, borderRadius: 3, background: "rgba(91,71,80,.28)", margin: "0 auto 10px" }} />
          <button className="kg-ich-btn" onClick={onClose} aria-label="sluiten"
            style={{ position: "absolute", top: 14, right: 14, width: 36, height: 36, borderRadius: "50%",
              background: "rgba(255,255,255,.85)", border: "none", color: INK, fontSize: 16, lineHeight: 1,
              fontWeight: 800, boxShadow: SHADOW_SOFT }}>✕</button>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 38, filter: "drop-shadow(0 4px 8px rgba(150,110,80,.25))" }}>{cz.emoji}</span>
            <div style={{ minWidth: 0, paddingRight: 40 }}>
              <h2 style={{ fontFamily: F_DISPLAY, fontSize: 19, fontWeight: 800, color: INK, lineHeight: 1.25, margin: 0 }}>{r.title}</h2>
              {r.subtitle && <div style={{ fontSize: 13, color: "rgba(91,71,80,.8)", marginTop: 2, fontWeight: 600 }}>{r.subtitle}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
            {r.cuisine && <span style={{ fontSize: 12.5, fontWeight: 800, color: SAKURA_DP, background: "rgba(255,255,255,.7)", borderRadius: R_PILL, padding: "3px 11px" }}>{r.cuisine}</span>}
            <span style={{ fontSize: 12.5, fontWeight: 800, color: INK, background: "rgba(255,255,255,.7)", borderRadius: R_PILL, padding: "3px 11px" }}>👥 {servings} porties</span>
            {(r.tags || []).map(t2 => (
              <span key={t2} style={{ fontSize: 12.5, fontWeight: 700, color: INK_SOFT, background: "rgba(255,255,255,.55)", borderRadius: R_PILL, padding: "3px 11px" }}>{t2}</span>
            ))}
          </div>
        </div>

        {/* sheet body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px 20px",
          display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── COOKING MODE ── */}
          <div style={{ fontFamily: F_DISPLAY, fontSize: 15, fontWeight: 800, color: MATCHA_DP,
            display: "flex", alignItems: "center", gap: 8 }}>
            🔥 Cooking mode <span style={{ fontFamily: F_ROUND, fontSize: 13, fontWeight: 600, color: INK_SOFT }}>: elke fase, elke minuut</span>
          </div>

          {/* total + split bar */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: INK_SOFT }}>Totale tijd</div>
              <div style={{ fontFamily: F_DISPLAY, fontSize: 34, fontWeight: 800, color: SAKURA_DP, lineHeight: 1 }}>
                {t.total}<span style={{ fontFamily: F_ROUND, fontSize: 13, fontWeight: 600, color: INK_SOFT }}> min</span>
              </div>
            </div>
            <div role="img" aria-label={`${t.active} minuten actief, ${t.passive} minuten wachten`}
              style={{ display: "flex", gap: 4, flex: 1, minWidth: 200, height: 40, borderRadius: R_PILL,
                overflow: "hidden", boxShadow: SHADOW_SOFT }}>
              <div style={{ flex: activeFlex, background: SAKURA, display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 12.5, fontWeight: 800, whiteSpace: "nowrap" }}>{t.active}′ actief</div>
              {passiveFlex > 0 && (
                <div style={{ flex: passiveFlex, background: RAMUNE, display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#2E6E77", fontSize: 12.5, fontWeight: 800, whiteSpace: "nowrap" }}>{t.passive}′ wachten</div>
              )}
            </div>
          </div>

          {/* parallel-work tip */}
          {t.tip && (
            <div style={{ background: "#FFF7E6", borderRadius: R_MD, padding: "12px 15px", fontSize: 13.5, color: INK,
              boxShadow: SHADOW_SOFT, lineHeight: 1.5 }}>
              💡 <b style={{ color: SAKURA_DP }}>Parallel:</b> {t.tip}
            </div>
          )}

          {/* per-phase step timeline */}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 9 }}>
            {t.steps.map((s, i) => {
              const passive = s.mode === "passive";
              return (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, background: RICE,
                  borderRadius: R_MD, padding: "11px 13px" }}>
                  <span style={{ flex: "0 0 auto", width: 28, height: 28, borderRadius: "50%", background: MATCHA,
                    color: "#fff", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{s.text}</span>
                  {s.minutes != null && (
                    <span style={{ flex: "0 0 auto", fontSize: 13, fontWeight: 800, padding: "5px 11px", borderRadius: R_PILL,
                      whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                      background: passive ? "#E4F3F5" : "#FFE3EA", color: passive ? RAMUNE_DP : SAKURA_DP }}>
                      {s.minutes}′{passive ? " wachten" : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <p style={{ fontSize: 13, color: INK_SOFT, margin: 0, lineHeight: 1.6 }}>
            <b style={{ color: INK }}>Roze = handen bezig, blauw = je bent vrij.</b> Per-fase tijden zijn een schatting uit het recept, pas ze gerust aan.
          </p>

          {/* ── INGREDIËNTEN ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
            <div style={{ fontFamily: F_DISPLAY, fontSize: 15, fontWeight: 800, color: MATCHA_DP }}>🧂 Ingrediënten</div>
            {!editing && (
              <button className="kg-ich-btn" onClick={startEdit} aria-label="Ingrediënten aanpassen"
                style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, background: "#FFF0F3", border: "none",
                  borderRadius: R_PILL, color: SAKURA_DP, fontSize: 12.5, fontWeight: 800, padding: "6px 13px",
                  boxShadow: SHADOW_SOFT, cursor: "pointer" }}>
                ✏️ Aanpassen
              </button>
            )}
          </div>

          {!editing ? (
            /* read view — scaled to the porties setting */
            <div>
              {(r.ingredients || []).length === 0 && (
                <div style={{ fontSize: 13.5, color: INK_SOFT, padding: "8px 0" }}>
                  Nog geen ingrediënten — tik <b style={{ color: SAKURA_DP }}>Aanpassen</b> om ze toe te voegen.
                </div>
              )}
              {(r.ingredients || []).map((ing, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 14, color: INK,
                  minHeight: 40, padding: "4px 0", borderBottom: `1px solid ${LINE}` }}>
                  <span style={{ fontWeight: 600 }}>{ing.name}</span>
                  <span style={{ fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {fmtQty((Number(ing.qty) || 0) * scale)} {ing.unit}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            /* edit view — BASE quantities (per r.servings), not the scaled amounts */
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ fontSize: 12, color: INK_SOFT, fontWeight: 700 }}>
                Hoeveelheden per {r.servings || servings} porties. In de boodschappenlijst worden ze naar je porties geschaald.
              </div>
              {draft.map((row, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input value={row.name} onChange={e => setRow(i, "name", e.target.value)} placeholder="ingrediënt"
                    aria-label={`Naam ingrediënt ${i + 1}`}
                    style={{ flex: 1, minWidth: 0, fontFamily: F_ROUND, fontSize: 14, fontWeight: 600, color: INK,
                      background: RICE, border: `1px solid ${LINE}`, borderRadius: R_SM, padding: "9px 11px" }} />
                  <input value={row.qty} onChange={e => setRow(i, "qty", e.target.value)} placeholder="0" inputMode="decimal"
                    aria-label={`Hoeveelheid ${i + 1}`}
                    style={{ width: 58, fontFamily: F_ROUND, fontSize: 14, fontWeight: 800, color: SAKURA_DP, textAlign: "right",
                      background: RICE, border: `1px solid ${LINE}`, borderRadius: R_SM, padding: "9px 8px",
                      fontVariantNumeric: "tabular-nums" }} />
                  <input value={row.unit} onChange={e => setRow(i, "unit", e.target.value)} placeholder="g"
                    aria-label={`Eenheid ${i + 1}`}
                    style={{ width: 62, fontFamily: F_ROUND, fontSize: 13, fontWeight: 700, color: INK,
                      background: RICE, border: `1px solid ${LINE}`, borderRadius: R_SM, padding: "9px 8px" }} />
                  <button className="kg-ich-btn" onClick={() => removeRow(i)} aria-label={`Verwijder ${row.name || `ingrediënt ${i + 1}`}`}
                    style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%", border: "none", background: "#FFE9EC",
                      color: AZUKI, fontSize: 15, fontWeight: 800, lineHeight: 1, cursor: "pointer" }}>×</button>
                </div>
              ))}
              <button className="kg-ich-btn" onClick={addRow}
                style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 7, background: "transparent",
                  border: `2px dashed ${MATCHA}`, borderRadius: R_PILL, color: MATCHA_DP, fontSize: 13.5, fontWeight: 800,
                  padding: "8px 16px", cursor: "pointer" }}>
                ＋ Ingrediënt toevoegen
              </button>
              {editErr && (
                <div role="alert" style={{ fontSize: 13, fontWeight: 700, color: AZUKI }}>{editErr}</div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
                <button className="kg-ich-btn" onClick={saveEdit} disabled={saving}
                  style={{ background: MATCHA, border: "none", borderRadius: R_PILL, color: "#fff", fontSize: 14, fontWeight: 800,
                    padding: "10px 22px", minHeight: 44, boxShadow: SHADOW_SOFT, cursor: saving ? "wait" : "pointer",
                    opacity: saving ? 0.7 : 1 }}>
                  {saving ? "Bewaren…" : "Bewaar"}
                </button>
                <button className="kg-ich-btn" onClick={cancelEdit} disabled={saving}
                  style={{ background: "transparent", border: `1px solid ${LINE}`, borderRadius: R_PILL, color: INK_SOFT,
                    fontSize: 14, fontWeight: 800, padding: "10px 22px", minHeight: 44, cursor: "pointer" }}>
                  Annuleer
                </button>
              </div>
            </div>
          )}
        </div>

        {/* sheet footer — add / [− n +] stepper */}
        <div style={{ flexShrink: 0, padding: "12px 20px", paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          borderTop: `1px solid ${LINE}`, display: "flex",
          alignItems: "center", justifyContent: inPlan ? "space-between" : "flex-end", gap: 12, background: "#FFFDFB" }}>
          {inPlan && (
            <span style={{ fontSize: 13.5, fontWeight: 700, color: INK_SOFT }}>
              {count}× in je bento{count > 1 ? " · meerdere dagen 🍱" : ""}
            </span>
          )}
          {inPlan ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: SAKURA, borderRadius: R_PILL,
              padding: "6px 8px", boxShadow: SHADOW_SOFT }}>
              <button className="kg-ich-btn" onClick={onRemoveOne} aria-label="één dag minder"
                style={{ width: 38, height: 38, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.9)",
                  color: AZUKI, fontSize: 20, fontWeight: 800, lineHeight: 1, cursor: "pointer" }}>–</button>
              <span style={{ minWidth: "2.2ch", textAlign: "center", color: "#fff", fontSize: 15, fontWeight: 800,
                fontVariantNumeric: "tabular-nums" }}>{count}</span>
              <button className="kg-ich-btn" onClick={onAdd} disabled={!canAdd}
                title={canAdd ? "Nog een dag" : `Bento vol (${MAX_DINNERS})`} aria-label="nog een dag"
                style={{ width: 38, height: 38, borderRadius: "50%", border: "none",
                  background: canAdd ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.5)",
                  color: canAdd ? SAKURA_DP : "#D8907F", fontSize: 20, fontWeight: 800, lineHeight: 1,
                  cursor: canAdd ? "pointer" : "not-allowed" }}>+</button>
            </div>
          ) : (
            <button className="kg-ich-btn" onClick={onAdd} disabled={!canAdd}
              style={{ background: canAdd ? SAKURA : "#F3E6D6", border: "none", borderRadius: R_PILL,
                color: canAdd ? "#fff" : "#C7A98F", fontSize: 15, fontWeight: 800, minHeight: 48,
                padding: "12px 24px", boxShadow: canAdd ? SHADOW_SOFT : "none",
                cursor: canAdd ? "pointer" : "not-allowed" }}>
              {canAdd ? "In m'n bento +" : `Bento vol (${MAX_DINNERS})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add-a-recipe-from-URL sheet ─────────────────────────────────────────────
// Same bottom-sheet / centered-modal shell as the others (position:absolute so it
// works in both mounts). Paste a public recipe link → the server pulls its
// schema.org JSON-LD into the corpus and hands the normalized recipe back.
function AddUrlSheet({ url, setUrl, busy, err, onSubmit, onClose }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  return (
    <div onClick={onClose} className="kg-ich-overlay" style={{ position: "absolute", inset: 0, zIndex: 86, background: "rgba(75,59,66,.42)",
      display: "flex", alignItems: "flex-end", justifyContent: "center", animation: "ichFade .18s ease" }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="Recept via URL toevoegen" className="kg-ich-sheet"
        style={{ width: "100%", maxWidth: 520, maxHeight: "92%", background: CARD,
          borderRadius: `${R_LG}px ${R_LG}px 0 0`, overflow: "hidden", display: "flex", flexDirection: "column",
          animation: "ichSheet .22s ease", boxShadow: "0 -18px 60px rgba(150,110,80,.38)", fontFamily: F_ROUND, color: INK }}>
        {/* header — matcha banner */}
        <div style={{ position: "relative", padding: "10px 20px 16px", background: `linear-gradient(150deg, ${MATCHA}, ${RAMUNE})`, color: "#fff" }}>
          <div aria-hidden="true" className="kg-ich-grab" style={{ width: 44, height: 5, borderRadius: 3, background: "rgba(255,255,255,.45)", margin: "0 auto 10px" }} />
          <button className="kg-ich-btn" onClick={onClose} aria-label="sluiten"
            style={{ position: "absolute", top: 14, right: 14, width: 36, height: 36, borderRadius: "50%",
              background: "rgba(255,255,255,.85)", border: "none", color: INK, fontSize: 16, lineHeight: 1, fontWeight: 800 }}>✕</button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 30, filter: "drop-shadow(0 4px 8px rgba(60,110,80,.3))" }}>🔗</span>
            <div>
              <h2 style={{ fontFamily: F_DISPLAY, fontSize: 18, fontWeight: 800, margin: 0, lineHeight: 1.2 }}>Recept via URL</h2>
              <div style={{ fontSize: 12.5, opacity: .95, marginTop: 2, fontWeight: 600 }}>Plak een receptlink — ik haal 'm binnen 🍱</div>
            </div>
          </div>
        </div>

        {/* body — the URL field + submit */}
        <form onSubmit={onSubmit} style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <input ref={inputRef} type="url" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
            className="kg-ich-search-input" value={url} onChange={e => setUrl(e.target.value)}
            placeholder="https://… (recept van eender welke site)" disabled={busy}
            style={{ padding: "12px 16px" }} />
          {err && (
            <div role="alert" style={{ background: "#FFECEF", color: AZUKI, fontSize: 13, fontWeight: 700,
              borderRadius: R_MD, padding: "10px 13px", lineHeight: 1.5 }}>
              😖 {err}
            </div>
          )}
          <p style={{ fontSize: 12.5, color: G_MUTED, margin: 0, lineHeight: 1.6 }}>
            Werkt met de meeste receptensites (HelloFresh, Colruyt, Dagelijkse Kost…). Het gerecht landt meteen in je bibliotheek.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 2 }}>
            <button type="button" className="kg-ich-btn" onClick={onClose} disabled={busy}
              style={{ background: "#fff", border: `2px solid ${LINE}`, borderRadius: R_PILL,
                color: INK_SOFT, fontSize: 14, fontWeight: 800, minHeight: 48, padding: "11px 18px" }}>
              Annuleer
            </button>
            <button type="submit" className="kg-ich-btn" disabled={busy || !url.trim()}
              style={{ background: busy || !url.trim() ? "#CDE9D5" : MATCHA_DP, border: "none", borderRadius: R_PILL,
                color: "#fff", fontSize: 14.5, fontWeight: 800, minHeight: 48, padding: "11px 22px",
                boxShadow: busy || !url.trim() ? "none" : SHADOW_SOFT,
                cursor: busy || !url.trim() ? "not-allowed" : "pointer" }}>
              {busy ? "Ophalen…" : "Toevoegen +"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Jumbo Gent floorplan SVG builder ────────────────────────────────────────
// Same rendering as the standalone _output/ichikawa/route-map artifact — kept in
// sync by hand. Builds a schematic plan: needed zones lit + numbered, the dashed
// walking path INGANG → stops → Kassa's. STORE + engine are the shared sources.
const _esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function _wrapLabel(label) {
  if (label.length <= 15) return [label];
  const mid = Math.floor(label.length / 2);
  let cut = label.indexOf(" ", mid);
  if (cut < 0) cut = label.lastIndexOf(" ", mid);
  if (cut < 0) return [label];
  return [label.slice(0, cut), label.slice(cut + 1)];
}
function _zoneRect(z, active, num, count) {
  const lines = _wrapLabel(z.label);
  const ty = z.cy - (lines.length - 1) * 8 - 6;
  let out = "<g>";
  if (active) out += `<rect x="${z.x - 3}" y="${z.y - 3}" width="${z.w + 6}" height="${z.h + 6}" rx="14" fill="${z.accent}" opacity="0.16"/>`;
  out += `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="12" fill="${active ? z.accent : "#FBF3E8"}" fill-opacity="${active ? 0.22 : 1}" stroke="${active ? z.accent : LINE}" stroke-width="${active ? 3 : 1.5}"/>`;
  out += `<text x="${z.cx}" y="${ty}" text-anchor="middle" font-size="20">${z.emoji}</text>`;
  lines.forEach((ln, i) => {
    out += `<text x="${z.cx}" y="${ty + 18 + i * 14}" text-anchor="middle" font-weight="700" font-size="${z.w < 130 ? 11 : 12.5}" fill="${active ? INK : INK_SOFT}">${_esc(ln)}</text>`;
  });
  if (active) {
    out += `<circle cx="${z.x + 16}" cy="${z.y + 16}" r="13" fill="${SAKURA}"/>`;
    out += `<text x="${z.x + 16}" y="${z.y + 21}" text-anchor="middle" font-size="14" font-weight="800" fill="#fff">${num}</text>`;
    out += `<g transform="translate(${z.x + z.w - 14},${z.y + 16})"><rect x="-16" y="-11" width="32" height="22" rx="11" fill="#fff" stroke="${z.accent}" stroke-width="2"/><text x="0" y="5" text-anchor="middle" font-size="12" font-weight="800" fill="${z.accent}">${count}×</text></g>`;
  }
  return out + "</g>";
}
function _endpointBox(e, color) {
  return `<g><rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="12" fill="${color}" opacity="0.92"/><text x="${e.cx}" y="${e.cy + 6}" text-anchor="middle" font-size="16" font-weight="800" fill="#fff">${e.emoji} ${_esc(e.label)}</text></g>`;
}
function buildFloorplanSVG(route) {
  const need = new Set(route.stops.map(s => s.zone.id));
  const numOf = {}; route.stops.forEach((s, i) => { numOf[s.zone.id] = i + 1; });
  const [vw, vh] = [STORE.viewBox[2], STORE.viewBox[3]];
  let svg = `<svg viewBox="0 0 ${vw} ${vh}" width="100%" role="img" aria-label="Plattegrond Jumbo Gent met looproute">`;
  svg += `<defs><marker id="ichArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#FF6E92"/></marker></defs>`;
  svg += `<rect x="8" y="8" width="${vw - 16}" height="${vh - 16}" rx="22" fill="#fff" stroke="${LINE}" stroke-width="2"/>`;
  for (const z of STORE.zones) {
    if (z.id === "overig" && !need.has("overig")) continue;
    const s = route.stops.find(st => st.zone.id === z.id);
    svg += _zoneRect(z, need.has(z.id), numOf[z.id], s ? s.items.length : 0);
  }
  svg += _endpointBox(STORE.endpoints.ingang, LACQUER);
  svg += _endpointBox(STORE.endpoints.kassa, MATCHA_DP);
  if (route.stops.length) {
    const pts = route.path.map(p => [p.cx, p.cy]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
    svg += `<path d="${d}" fill="none" stroke="${SAKURA}" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 10" opacity="0.9" marker-end="url(#ichArrow)"/>`;
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
      const ang = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI;
      svg += `<g transform="translate(${mx},${my}) rotate(${ang})"><path d="M-5,-5 L5,0 L-5,5 z" fill="#FF6E92"/></g>`;
    }
    pts.forEach(p => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="#fff" stroke="#FF6E92" stroke-width="2.5"/>`; });
  }
  return svg + "</svg>";
}

// ─── Store floorplan sheet — the shopping list along the real Jumbo Gent path ─
// Ticks are the SAME persisted set as the SHOP checklist (checked/onToggle from
// the parent), so a tick on the map survives closing the sheet AND a reload.
function RouteSheet({ items, servings, checked, onToggle, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const route = useMemo(() => buildRoute(items, STORE), [items]);
  const svg = useMemo(() => buildFloorplanSVG(route), [route]);
  const overig = route.stops.find(s => s.zone.id === "overig");

  return (
    <div onClick={onClose} className="kg-ich-overlay" style={{ position: "absolute", inset: 0, zIndex: 85, background: "rgba(75,59,66,.42)",
      display: "flex", alignItems: "flex-end", justifyContent: "center", animation: "ichFade .18s ease" }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="Plattegrond Jumbo Gent" className="kg-ich-sheet"
        style={{ width: "100%", maxWidth: 640, maxHeight: "94%", background: CARD,
          borderRadius: `${R_LG}px ${R_LG}px 0 0`, overflow: "hidden", display: "flex", flexDirection: "column",
          animation: "ichSheet .22s ease", boxShadow: "0 -18px 60px rgba(150,110,80,.38)", fontFamily: F_ROUND, color: INK }}>
        <div style={{ position: "relative", padding: "10px 20px 14px", background: `linear-gradient(150deg, ${SAKURA}, ${AZUKI})`, color: "#fff" }}>
          <div aria-hidden="true" className="kg-ich-grab" style={{ width: 44, height: 5, borderRadius: 3, background: "rgba(255,255,255,.45)", margin: "0 auto 10px" }} />
          <button className="kg-ich-btn" onClick={onClose} aria-label="sluiten"
            style={{ position: "absolute", top: 14, right: 14, width: 36, height: 36, borderRadius: "50%",
              background: "rgba(255,255,255,.85)", border: "none", color: INK, fontSize: 16, lineHeight: 1, fontWeight: 800 }}>✕</button>
          <div style={{ fontFamily: F_DISPLAY, fontSize: 18, fontWeight: 800 }}>🗺️ Looproute · Jumbo Foodmarkt Gent</div>
          <div style={{ fontSize: 13, opacity: .95, marginTop: 2 }}>
            {route.total} items · {route.stops.length} {route.stops.length === 1 ? "halte" : "haltes"} · {servings}p
            {overig ? ` · ${overig.items.length} onbekend ❓` : ""}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14,
          padding: "16px 16px 20px" }}>
          <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: R_MD, padding: 10 }}
            dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            {route.stops.map((s, i) => (
              <div key={s.zone.id} style={{ border: `1px solid ${LINE}`, borderRadius: 14, padding: "10px 13px", marginBottom: 10, background: "#FFFCF8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 800, fontFamily: F_DISPLAY, fontSize: 15 }}>
                  <span style={{ flex: "0 0 24px", width: 24, height: 24, borderRadius: "50%", background: SAKURA, color: "#fff",
                    fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(255,157,178,.5)" }}>{i + 1}</span>
                  {s.zone.emoji} {s.zone.label}
                  <span style={{ marginLeft: "auto", fontSize: 12, color: INK_SOFT, fontWeight: 700 }}>{s.items.length}×</span>
                </div>
                <ul style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
                  {s.items.map((it, j) => {
                    const key = keyOf(it); const on = checked.has(key);
                    return (
                      <li key={`${key}_${j}`}>
                        <label className={`kg-ich-gitem${on ? " kg-ich-gitem--on" : ""}`} style={{ minHeight: 46 }}>
                          <input type="checkbox" checked={on} onChange={() => onToggle(key)} />
                          <span className="kg-ich-gnm">{it.name}</span>
                          {it.qty ? <span style={{ fontSize: 13, fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtQty(it.qty)} {it.unit}</span> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

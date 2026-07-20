import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import STORE from "../data/jumbo-gent-store.json";
import { buildRoute } from "./lib/jumboRoute.js";

/* ──────────────────────────────────────────────────────────────────────────
   ICHIKAWA · 市川 · MARKET SCOUT   (kage-gumi personal operative)

   A fully RE-SKINNED surface that lives inside the kage-gumi runtime but reads
   as its own product — a KAWAII BENTO RESTAURANT (light, cute, fluffy). The
   dark "Shadow Crew Protocol" KG chrome is dropped entirely; reached at
   #ichikawa (never shown in the professional KG showcase).

     • RECEPTEN     — a soft/rounded Recipe Library grid (Dutch / Belgian
                      HelloFresh style) with pastel food-photo placeholders.
     • WEEKPLAN     — the weekly plan IS a dark-lacquer bento tray: pick up to 5
                      dinners to fill the compartments → an aggregated shopping
                      list assembles itself (unit-aware dedupe, scaled to a
                      servings target, default 2).
     • COOKING MODE — the recipe detail is time-oriented: a total-time split bar
                      (hands-on active = sakura vs waiting passive = ramune), a
                      per-phase step timeline (pink = active, blue = passive) and
                      a parallel-work tip. Renders from real per-phase step data.

   Mascots (Onigiri-chan / Ichikawa the cat scout / Tamago-chan / Matcha-kun)
   are inline SVG stickers tied to app states (empty / added / loading).

   Data comes from GET /api/ichikawa/recipes; the committed seed corpus is the
   offline fallback so the shell always renders. Engine (HelloFresh pull, photo→
   recipe, store pricing) is Phase 2+ — this file is surface + seed only.

   KG-authored: root carries data-kg-* attribution; children use kg-ich-* classes.
   Fonts: M PLUS Rounded 1c + Baloo 2, loaded via Google Fonts @import — the same
   mechanism KG already uses for DM Sans / Noto Serif JP.
   ────────────────────────────────────────────────────────────────────────── */

// ─── Kawaii bento palette (from the approved style tile — used exactly) ──────
const RICE      = "#FFF6EA";  // warm rice-cream ground
const RICE2     = "#FDEEDC";
const CARD      = "#FFFDF9";
const INK       = "#5B4750";  // warm plum-brown — never pure black
const INK_SOFT  = "#9A8189";
const SAKURA    = "#FF9DB2";  // primary
const SAKURA_DP = "#F26D8B";
const MATCHA    = "#93CFA0";  // secondary (the old lime, kawaii-fied)
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

const MAX_DINNERS = 5;

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

// Pastel tag-chip styles, cycled by index.
const CHIP_STYLES = [
  { bg: "#FFF0E6", fg: SAKURA_DP },
  { bg: "#E9F6EC", fg: MATCHA_DP },
  { bg: "#E6F5F7", fg: RAMUNE_DP },
  { bg: "#FFF5DE", fg: "#C58A16" },
];

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

// ─── Theme-aware ground tokens (layout-2.0 port) ────────────────────────────
// The kawaii brand stays: cards, chips and accents are fixed pastel islands
// that are self-consistent (cream bg + plum ink) in either theme. Only the
// page GROUND and the text sitting DIRECTLY on it follow the KG theme tokens,
// so the surface stays legible in both dark and light. NB hard rule: never
// `var(--x)55` hex-alpha on a var — alpha only via color-mix.
const G_BG    = `var(--kg-bg-page, ${RICE})`;
const G_TEXT  = `var(--kg-text-body, ${INK})`;
const G_MUTED = `var(--kg-text-muted, ${INK_SOFT})`;
const G_LINE  = `var(--kg-border, ${LINE})`;
const G_DOTS  = `color-mix(in srgb, var(--kg-border, ${LINE}) 60%, transparent)`;

// ─── Week helpers — tonight-hero + 7-day weekmenu strip ─────────────────────
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

// Section heading — the mockup's "sec-tag" pattern (label + fading rule +
// right-hand stamp), kawaii-skinned. `onCard`: inside a cream card use fixed
// kawaii ink; on the themed page ground use KG tokens so both themes read.
function SecTag({ k, label, right, onCard = false }) {
  const muted = onCard ? INK_SOFT : G_MUTED;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "0 0 16px" }}>
      <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: SAKURA_DP, whiteSpace: "nowrap" }}>
        {k} {label}
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${BLUSH}, transparent)` }} />
      {right ? <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.14em", color: muted, whiteSpace: "nowrap" }}>{right}</span> : null}
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

// ─── Mascots — inline SVG sticker set (genuinely cute: dot eyes, blush, smile).
//     Each is tied to an app state; all self-contained, no external assets. ──
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

// Offline fallback — a tiny subset so the surface is never blank if kg-api is
// unreachable. The full committed corpus is served by GET /api/ichikawa/recipes.
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

export default function IchikawaSurface({ onExit }) {
  const [recipes, setRecipes] = useState([]);
  const [source, setSource]   = useState("");   // 'corpus' | 'seed' | 'empty'
  const [loaded, setLoaded]   = useState(false);
  const [selected, setSelected] = useState([]); // recipe ids in the weekly plan (order = pick order)
  const [servings, setServings] = useState(2);  // scaling target (default 2)
  const [detail, setDetail]     = useState(null); // recipe open in the detail modal
  const [showRoute, setShowRoute] = useState(false); // Jumbo Gent looproute modal open?
  const [tag, setTag]           = useState("all"); // library filter (recipe tags)
  const [cat, setCat]           = useState("all"); // main-ingredient filter (meat/fish/veg…)
  const [search, setSearch]     = useState("");    // keyword search — title/subtitle/tags/cuisine/ingredients
  const [timeMax, setTimeMax]   = useState(null);  // active time-filter bucket (minutes, null = "Alles")
  const [removedIds, setRemovedIds] = useState(() => new Set()); // soft-removed this session (optimistic)
  const [removeNote, setRemoveNote] = useState(null); // gentle failure note when a remove doesn't stick
  const [heroIdx, setHeroIdx]   = useState(null); // pinned "vanavond" slot; null = auto (today's slot, else first)
  const [aisleChecked, setAisleChecked] = useState(() => new Set()); // inline grocery ticks, key = name__unit
  const libRef = useRef(null); // scroll target: empty weekmenu slot → receptenbibliotheek

  // Load the corpus. API first; committed seed as the offline fallback so the
  // shell is never empty even if kg-api is down.
  useEffect(() => {
    let alive = true;
    API_GET("/api/recipes")
      .then(d => { if (!alive) return; setRecipes(d.recipes || []); setSource(d.source || ""); })
      .catch(() => { if (!alive) return; setRecipes(FALLBACK_RECIPES); setSource("offline"); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

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

  // Visible library list: not removed → category → tag → keyword search → time bucket (all AND).
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
  // compartments (cook the same dinner two days). Order = pick order = compartment.
  const countOf = useCallback(id => selected.filter(x => x === id).length, [selected]);

  function addToPlan(id) {
    setSelected(prev => (prev.length >= MAX_DINNERS ? prev : [...prev, id])); // cap at 5 dinners total
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

  // ── Aggregated shopping list ────────────────────────────────────────────────
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

  // Walk-ordered route over the CURRENT list — powers the inline aisled grocery
  // checklist + the winkelroute chip strip (same engine as the floorplan modal).
  const route = useMemo(() => buildRoute(shoppingList, STORE), [shoppingList]);
  const toggleAisle = useCallback(key => {
    setAisleChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);
  const checkedCount = useMemo(
    () => shoppingList.filter(it => aisleChecked.has(`${it.name}__${it.unit}`)).length,
    [shoppingList, aisleChecked]
  );

  // Week frame (MA..ZO of the current week) + the "vanavond" hero slot.
  // Slot i of the plan = weekday i (MA..VR); hero = today's slot if filled,
  // else the first filled slot; "Recept wisselen" pins the next one.
  const { todayIdx, days: weekDays, week: weekNr } = useMemo(() => weekInfo(), []);
  const autoHero = selected[todayIdx] != null ? todayIdx : (selected.length ? 0 : -1);
  const hIdx = heroIdx != null && heroIdx < selected.length ? heroIdx : autoHero;
  const heroRecipe = hIdx >= 0 ? byId(selected[hIdx]) : null;
  const heroT = heroRecipe ? cookTiming(heroRecipe) : null;

  // Aggregate week stats for the hero side panel (times + eiwitbalans).
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

  return (
    <div className="kg-ichikawa" data-kg-component="ichikawa-surface" data-kg-owner="kg"
      style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden",
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
        .kg-ichikawa *{box-sizing:border-box;}
        .kg-ichikawa ::-webkit-scrollbar{width:9px;height:9px;}
        .kg-ichikawa ::-webkit-scrollbar-track{background:transparent;}
        .kg-ichikawa ::-webkit-scrollbar-thumb{background:${LINE};border-radius:9px;}
        .kg-ichikawa ::-webkit-scrollbar-thumb:hover{background:#E6CBB0;}
        .kg-ich-bob{animation:ichBob 4s ease-in-out infinite;transform-origin:center;}
        .kg-ich-card{transition:transform .18s ease, box-shadow .18s ease;}
        .kg-ich-card:hover{transform:translateY(-4px);box-shadow:${SHADOW_LIFT};}
        .kg-ich-btn{transition:transform .12s ease, filter .12s ease, background .15s ease, color .15s ease;cursor:pointer;font-family:inherit;}
        .kg-ich-btn:hover{transform:translateY(-2px);filter:saturate(1.08);}
        .kg-ich-btn:focus-visible{outline:3px solid ${RAMUNE};outline-offset:2px;}
        .kg-ich-chip{transition:transform .12s ease, filter .12s ease;cursor:pointer;font-family:inherit;}
        .kg-ich-chip:hover{transform:translateY(-1px);}
        .kg-ich-cell{transition:transform .15s ease, box-shadow .15s ease;}
        .kg-ich-cell:hover{transform:translateY(-2px);box-shadow:${SHADOW_SOFT};}
        .kg-ich-title{cursor:pointer;transition:color .15s ease;}
        .kg-ich-title:hover{color:${SAKURA_DP};}
        .kg-ich-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
        .kg-ich-search-input{width:100%;max-width:420px;box-sizing:border-box;background:#fff;
          border:2px solid ${LINE};border-radius:${R_PILL}px;padding:11px 20px 11px 40px;
          font-size:14px;font-family:inherit;color:${INK};box-shadow:${SHADOW_SOFT};outline:none;
          transition:border-color .15s ease, box-shadow .15s ease;}
        .kg-ich-search-input::placeholder{color:${INK_SOFT};}
        .kg-ich-search-input:focus{border-color:${MATCHA_DP};box-shadow:0 0 0 3px rgba(147,207,160,.28), ${SHADOW_SOFT};}
        .kg-ich-remove{flex-shrink:0;width:24px;height:24px;border-radius:50%;border:none;
          background:#FFE9EC;color:${AZUKI};font-size:13px;font-weight:800;line-height:1;
          box-shadow:0 2px 5px rgba(214,91,120,.28);opacity:0;cursor:pointer;}
        .kg-ich-card:hover .kg-ich-remove,.kg-ich-remove:focus-visible{opacity:1;}
        /* layout-2.0 grids: hero (main + stats side), 7-day strip, recept | boodschappen+route */
        .kg-ich-hero{display:grid;grid-template-columns:minmax(0,1fr) 300px;}
        .kg-ich-week{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;}
        .kg-ich-twocol{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:20px;align-items:start;}
        .kg-ich-day{transition:transform .15s ease, box-shadow .15s ease;}
        .kg-ich-day:hover{transform:translateY(-2px);box-shadow:${SHADOW_LIFT};}
        .kg-ich-gitem{display:flex;align-items:center;gap:10px;padding:5px 0;cursor:pointer;}
        .kg-ich-gitem input{accent-color:${MATCHA_DP};width:15px;height:15px;flex-shrink:0;cursor:pointer;margin:0;}
        .kg-ich-gitem .kg-ich-gnm{flex:1;font-size:13.5px;font-weight:600;color:${INK};transition:color .15s ease;}
        .kg-ich-gitem--on .kg-ich-gnm{color:${INK_SOFT};text-decoration:line-through;text-decoration-color:#D9C3AC;}
        @media(max-width:1500px){.kg-ich-week{grid-template-columns:repeat(4,1fr);}}
        @media(max-width:1250px){.kg-ich-hero,.kg-ich-twocol{grid-template-columns:1fr;}
          .kg-ich-hero-main{border-right:none !important;border-bottom:1px solid ${LINE};}}
        @media(prefers-reduced-motion:reduce){.kg-ich-bob{animation:none;}.kg-ich-card,.kg-ich-btn,.kg-ich-chip,.kg-ich-cell,.kg-ich-day{transition:none;}}
      `}</style>

      {/* ── Header — Ichikawa's own kawaii wordmark; no Shadow Crew chrome ── */}
      <header style={{ flexShrink: 0, position: "relative", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18,
        padding: "16px 30px", borderBottom: `1px solid ${LINE}`,
        background: "linear-gradient(160deg,#FFFDFB,#FFF0E4)", boxShadow: SHADOW_SOFT }}>
        <div aria-hidden="true" style={{ position: "absolute", right: -40, top: -70, width: 200, height: 200,
          background: "radial-gradient(circle,#FFE1B0,transparent 70%)", opacity: 0.55, pointerEvents: "none" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0, position: "relative", zIndex: 1 }}>
          <span style={{ fontFamily: F_ROUND, fontSize: 40, fontWeight: 800, color: SAKURA,
            textShadow: "2px 3px 0 #FFE3EA", lineHeight: 0.9 }}>市川</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: F_DISPLAY, fontSize: 26, fontWeight: 800, letterSpacing: 0.5, color: INK }}>
                Ichi<span style={{ color: MATCHA_DP }}>kawa</span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: SAKURA_DP }}>
                Market Scout
              </span>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.24em", color: MATCHA_DP,
                border: `2px solid ${MATCHA}`, borderRadius: R_PILL, padding: "1px 9px", background: "#fff" }}>
                PERSONAL
              </span>
            </div>
            <span style={{ fontSize: 14, color: INK_SOFT }}>
              Je kitchen-scout: weekbento &amp; boodschappen, netjes gesorteerd.
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative", zIndex: 1 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.16em", color: INK_SOFT, whiteSpace: "nowrap" }}>
            WEEK {weekNr} · {fmtD(weekDays[0])} - {fmtD(weekDays[6])}
          </span>
          <Mascot type="cat" size={54} style={{ marginRight: 2 }} />
          <span style={{ fontSize: 13.5, color: INK_SOFT, fontWeight: 600, whiteSpace: "nowrap" }}>
            {loaded ? `${recipes.length} recepten` : "laden…"}
          </span>
          {onExit && (
            <button className="kg-ich-btn" onClick={onExit}
              style={{ background: "#fff", border: "none", borderRadius: R_PILL, color: MATCHA_DP,
                fontSize: 14, fontWeight: 800, padding: "9px 16px", boxShadow: SHADOW_SOFT }}>
              ← Kage-gumi
            </button>
          )}
        </div>
      </header>

      {/* ── Body — layout-2.0 port: single scroll · vanavond-hero → weekmenu →
             recept + boodschappen/route → receptenbibliotheek ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "26px 34px 56px", animation: "ichFade .35s ease" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", flexDirection: "column", gap: 32 }}>

          {/* ═══ VANAVOND hero — dish + facts + actief/wachten split + week stats ═══ */}
          <section className="kg-ich-hero" style={{ background: CARD, borderRadius: R_LG, overflow: "hidden", boxShadow: SHADOW_SOFT }}>
            {heroRecipe && heroT ? (
              <>
                <div className="kg-ich-hero-main" style={{ position: "relative", padding: "24px 28px 26px", borderRight: `1px solid ${LINE}`, minWidth: 0 }}>
                  <span aria-hidden="true" style={{ position: "absolute", right: 14, top: 2, fontSize: 84, opacity: 0.14, pointerEvents: "none" }}>
                    {cuisineOf(heroRecipe.cuisine).emoji}
                  </span>
                  <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.3em", textTransform: "uppercase", color: SAKURA_DP, marginBottom: 10 }}>
                    今夜 · {hIdx === todayIdx ? "Wat eten we vanavond" : "Gepland"} · {DAY_FULL[hIdx]} {fmtD(weekDays[hIdx])}
                  </div>
                  <h2 className="kg-ich-title" onClick={() => setDetail(heroRecipe)}
                    style={{ fontFamily: F_DISPLAY, fontSize: 27, fontWeight: 800, color: INK, lineHeight: 1.25, margin: "0 0 8px", maxWidth: "26ch" }}>
                    {heroRecipe.title}
                  </h2>
                  {heroRecipe.subtitle && (
                    <p style={{ fontSize: 14, color: INK_SOFT, lineHeight: 1.7, margin: "0 0 18px", maxWidth: "52ch" }}>{heroRecipe.subtitle}</p>
                  )}
                  {/* facts row */}
                  <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 18 }}>
                    {[
                      [`${heroT.total}′`, "TOTAAL"],
                      [`${heroT.active}′`, "HANDS-ON"],
                      [String(servings), "PORTIES"],
                      [String((heroRecipe.ingredients || []).length), "INGREDIËNTEN"],
                    ].map(([v, l]) => (
                      <div key={l}>
                        <div style={{ fontFamily: F_DISPLAY, fontSize: 22, fontWeight: 800, color: INK, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{v}</div>
                        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.2em", color: INK_SOFT, marginTop: 3 }}>{l}</div>
                      </div>
                    ))}
                  </div>
                  {/* actief vs wachten split bar */}
                  <div role="img" aria-label={`${heroT.active} minuten actief, ${heroT.passive} minuten wachten`}
                    style={{ display: "flex", gap: 3, height: 12, borderRadius: R_PILL, overflow: "hidden", maxWidth: 460 }}>
                    <span style={{ flex: heroT.active || 1, background: SAKURA }} />
                    {heroT.passive > 0 && <span style={{ flex: heroT.passive, background: RAMUNE }} />}
                  </div>
                  <div style={{ display: "flex", gap: 18, marginTop: 8, fontSize: 12, fontWeight: 800, letterSpacing: "0.1em" }}>
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
                    <p style={{ margin: "14px 0 0", fontSize: 13.5, lineHeight: 1.6, color: INK_SOFT, borderLeft: `3px solid ${RAMUNE}`, paddingLeft: 12, maxWidth: "54ch" }}>
                      💡 {heroT.tip}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
                    <button className="kg-ich-btn" onClick={() => setDetail(heroRecipe)}
                      style={{ background: SAKURA, border: "none", borderRadius: R_PILL, color: "#fff",
                        fontSize: 14, fontWeight: 800, padding: "10px 18px", boxShadow: SHADOW_SOFT }}>
                      ▸ Start kookmodus
                    </button>
                    {selected.length > 1 && (
                      <button className="kg-ich-btn" onClick={() => setHeroIdx((hIdx + 1) % selected.length)}
                        style={{ background: "#fff", border: `2px solid ${LINE}`, borderRadius: R_PILL,
                          color: INK_SOFT, fontSize: 14, fontWeight: 800, padding: "8px 16px" }}>
                        Recept wisselen
                      </button>
                    )}
                  </div>
                </div>
                {/* week stats side panel */}
                <aside style={{ background: RICE2, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: MATCHA_DP }}>均 · Deze week</span>
                    <Mascot type="tamago" size={30} style={{ marginLeft: "auto", marginTop: -4 }} />
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
                </aside>
              </>
            ) : (
              /* empty hero — Onigiri-chan nudge */
              <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "44px 24px", textAlign: "center", color: INK_SOFT }}>
                <Mascot type="onigiri" size={72} />
                <div style={{ fontSize: 14.5, lineHeight: 1.65, maxWidth: "48ch" }}>
                  Nog geen diners gekozen! Tik <span style={{ color: SAKURA_DP, fontWeight: 800 }}>+</span> op een recept
                  in de bibliotheek hieronder om je week te vullen.
                </div>
              </div>
            )}
          </section>

          {/* ═══ WEEKMENU — 7-day strip (5 bento-slots + vrij weekend) ═══ */}
          <section>
            <SecTag k="献" label="Weekmenu" right={`${fmtD(weekDays[0])} - ${fmtD(weekDays[6])} · KLEUR = EIWIT`} />
            {/* plan controls — servings scaling + clear (always reachable) */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <span style={{ fontSize: 14, color: G_MUTED, fontWeight: 700 }}>Porties</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="kg-ich-btn" aria-label="minder porties" onClick={() => setServings(s => Math.max(1, s - 1))}
                  style={{ width: 30, height: 30, borderRadius: "50%", border: "none", background: MATCHA, color: "#fff",
                    fontSize: 18, fontWeight: 800, boxShadow: SHADOW_SOFT, lineHeight: 1 }}>–</button>
                <span style={{ fontSize: 19, fontWeight: 800, minWidth: "1.6ch", textAlign: "center", color: G_TEXT,
                  fontVariantNumeric: "tabular-nums" }}>{servings}</span>
                <button className="kg-ich-btn" aria-label="meer porties" onClick={() => setServings(s => Math.min(12, s + 1))}
                  style={{ width: 30, height: 30, borderRadius: "50%", border: "none", background: MATCHA, color: "#fff",
                    fontSize: 18, fontWeight: 800, boxShadow: SHADOW_SOFT, lineHeight: 1 }}>+</button>
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 800, color: selected.length ? SAKURA_DP : G_MUTED }}>
                {selected.length} / {MAX_DINNERS} diners
              </span>
              {selected.length > 0 && (
                <button className="kg-ich-btn" onClick={() => setSelected([])}
                  style={{ marginLeft: "auto", background: "#fff", border: "none", borderRadius: R_PILL,
                    color: INK_SOFT, fontSize: 13, fontWeight: 800, padding: "7px 13px", boxShadow: SHADOW_SOFT }}>
                  Leegmaken
                </button>
              )}
            </div>
            <div className="kg-ich-week" role="list" aria-label={`Weekmenu met ${selected.length} van ${MAX_DINNERS} geplande diners`}>
              {weekDays.map((d, i) => {
                const isToday = i === todayIdx;
                const dnum = String(d.getDate()).padStart(2, "0");
                if (i >= MAX_DINNERS) {
                  /* ZA/ZO — buiten het 5-diner bentoplan */
                  return (
                    <div key={i} role="listitem" style={{ minHeight: 148, borderRadius: R_MD, border: `2px dashed ${G_LINE}`,
                      padding: "12px 12px", display: "flex", flexDirection: "column", gap: 8, color: G_MUTED }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.18em", color: isToday ? SAKURA_DP : G_MUTED }}>
                          {DAY_ABBR[i]}{isToday ? " · VANDAAG" : ""}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{dnum}</span>
                      </div>
                      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700 }}>
                        vrije avond
                      </div>
                    </div>
                  );
                }
                const id = selected[i];
                const r = id ? byId(id) : null;
                if (!r) {
                  const firstEmpty = i === selected.length; // the next slot to fill
                  return (
                    <button key={i} role="listitem" className="kg-ich-btn"
                      onClick={() => libRef.current && libRef.current.scrollIntoView({ behavior: "smooth", block: "start" })}
                      style={{ minHeight: 148, borderRadius: R_MD, border: `2px dashed ${firstEmpty ? SAKURA : G_LINE}`,
                        background: "transparent", padding: "12px 12px", display: "flex", flexDirection: "column", gap: 8,
                        color: firstEmpty ? SAKURA_DP : G_MUTED, textAlign: "left" }}>
                      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.18em", color: isToday ? SAKURA_DP : G_MUTED }}>
                          {DAY_ABBR[i]}{isToday ? " · VANDAAG" : ""}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{dnum}</span>
                      </span>
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
                return (
                  <article key={i} role="listitem" className="kg-ich-day" onClick={() => setDetail(r)}
                    style={{ position: "relative", minHeight: 148, background: CARD, borderRadius: R_MD, padding: "12px 12px 10px",
                      display: "flex", flexDirection: "column", gap: 7, cursor: "pointer",
                      boxShadow: i === hIdx ? `0 0 0 3px ${SAKURA}, ${SHADOW_SOFT}` : SHADOW_SOFT }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 20 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.18em", color: isToday ? SAKURA_DP : INK_SOFT }}>
                        {DAY_ABBR[i]}{isToday ? " · VANDAAG" : ""}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#C7A98F", fontVariantNumeric: "tabular-nums" }}>{dnum}</span>
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
                    <button className="kg-ich-btn" aria-label={`"${r.title}" uit het weekmenu`}
                      onClick={e => { e.stopPropagation(); removeAt(i); }}
                      style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%",
                        border: "none", background: "#FFE9EC", color: AZUKI, fontSize: 14, lineHeight: 1,
                        fontWeight: 800, boxShadow: "0 2px 5px rgba(214,91,120,.28)" }}>×</button>
                  </article>
                );
              })}
            </div>
          </section>

          {/* ═══ RECEPT (act/wait steps) | BOODSCHAPPEN + WINKELROUTE ═══ */}
          <div className="kg-ich-twocol">
            {/* recipe card — vanavond's dish, full act/wait step detail */}
            <section style={{ background: CARD, borderRadius: R_LG, padding: "22px 26px", boxShadow: SHADOW_SOFT, minWidth: 0 }}>
              <SecTag onCard k="皿" label={`Recept · ${heroRecipe && hIdx !== todayIdx ? DAY_FULL[hIdx].toLowerCase() : "vanavond"}`}
                right={heroRecipe ? `${servings} PORTIES` : ""} />
              {heroRecipe && heroT ? (
                <>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: INK_SOFT, marginBottom: 6 }}>Ingrediënten</div>
                  <div style={{ columns: 2, columnGap: 26 }}>
                    {(heroRecipe.ingredients || []).map((ing, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0",
                        borderBottom: `1px solid ${LINE}`, breakInside: "avoid", fontSize: 14 }}>
                        <span style={{ fontWeight: 600, color: INK }}>{ing.name}</span>
                        <span style={{ fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {fmtQty((Number(ing.qty) || 0) * (servings / (heroRecipe.servings || servings || 1)))} {ing.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: INK_SOFT, margin: "20px 0 4px" }}>Bereiding</div>
                  <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {heroT.steps.map((s, i) => {
                      const passive = s.mode === "passive";
                      return (
                        <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0",
                          borderBottom: i < heroT.steps.length - 1 ? `1px solid ${LINE}` : "none" }}>
                          <span style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", background: passive ? RAMUNE : SAKURA,
                            color: "#fff", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{s.text}</span>
                          {s.minutes != null && (
                            <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: R_PILL,
                              whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", letterSpacing: "0.08em",
                              background: passive ? "#E4F3F5" : "#FFE3EA", color: passive ? RAMUNE_DP : SAKURA_DP }}>
                              {passive ? "WACHTEN" : "ACTIEF"} {s.minutes}′
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                  <p style={{ fontSize: 13, color: INK_SOFT, margin: "12px 0 0", lineHeight: 1.6 }}>
                    <b style={{ color: INK }}>Roze = handen bezig, blauw = je bent vrij.</b> Open de kookmodus voor de tijdlijn per fase.
                  </p>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "36px 0", color: INK_SOFT }}>
                  <Mascot type="matcha" size={64} bob={false} />
                  <span style={{ fontSize: 14, fontWeight: 700 }}>Kies een gerecht, dan verschijnt het recept hier.</span>
                </div>
              )}
            </section>

            {/* grocery checklist + winkelroute */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
              {/* aisled checklist — walk-ordered zones from the Jumbo route engine */}
              <section style={{ background: CARD, borderRadius: R_LG, padding: "22px 24px", boxShadow: SHADOW_SOFT }}>
                <SecTag onCard k="買" label="Boodschappen" right={shoppingList.length ? `${checkedCount} / ${shoppingList.length} BINNEN` : ""} />
                {route.stops.length === 0 ? (
                  <p style={{ fontSize: 14, color: INK_SOFT, margin: 0, lineHeight: 1.6 }}>
                    Je lijst is nog leeg. Vul eerst het weekmenu, dan verschijnen de boodschappen hier per gang gesorteerd.
                  </p>
                ) : (
                  <>
                    {route.stops.map((s, i) => (
                      <div key={s.zone.id} style={{ marginBottom: i < route.stops.length - 1 ? 16 : 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                          <span style={{ fontSize: 12, fontWeight: 800, color: MATCHA_DP, fontVariantNumeric: "tabular-nums" }}>{String(i + 1).padStart(2, "0")}</span>
                          <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: INK_SOFT }}>{s.zone.emoji} {s.zone.label}</span>
                          <span aria-hidden="true" style={{ flex: 1, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${LINE}, transparent)` }} />
                          <span style={{ fontSize: 11.5, fontWeight: 800, color: "#C7A98F", fontVariantNumeric: "tabular-nums" }}>{s.items.length}×</span>
                        </div>
                        {s.items.map((it, j) => {
                          const key = `${it.name}__${it.unit || ""}`;
                          const on = aisleChecked.has(key);
                          return (
                            <label key={`${key}_${j}`} className={`kg-ich-gitem${on ? " kg-ich-gitem--on" : ""}`}>
                              <input type="checkbox" checked={on} onChange={() => toggleAisle(key)} />
                              <span className="kg-ich-gnm">{it.name}</span>
                              {it.days && it.days.length > 0 && (
                                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "#C58A16",
                                  background: "#FFF5DE", borderRadius: R_PILL, padding: "1px 7px", whiteSpace: "nowrap" }}>
                                  {it.days.map(dd => DAY_ABBR[dd] || "").filter(Boolean).join("·")}
                                </span>
                              )}
                              {it.qty ? (
                                <span style={{ fontSize: 13, fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                                  {fmtQty(it.qty)} {it.unit}
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", color: INK_SOFT }}>WEEKLIJST · {servings}P · JUMBO GENT</span>
                      <span style={{ fontSize: 14, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums" }}>{checkedCount} / {shoppingList.length}</span>
                    </div>
                    <p style={{ fontSize: 12.5, color: INK_SOFT, margin: "10px 0 0", lineHeight: 1.6 }}>
                      Samengevoegd per ingrediënt (eenheid-bewust), geschaald naar {servings} porties.
                    </p>
                  </>
                )}
              </section>

              {/* winkelroute chip strip + floorplan modal launcher */}
              <section style={{ background: CARD, borderRadius: R_LG, padding: "22px 24px", boxShadow: SHADOW_SOFT }}>
                <SecTag onCard k="路" label="Winkelroute" right="JUMBO FOODMARKT GENT" />
                {route.stops.length === 0 ? (
                  <p style={{ fontSize: 14, color: INK_SOFT, margin: 0, lineHeight: 1.6 }}>
                    Zodra je lijst gevuld is, tekent Ichikawa hier de kortste ronde door de winkel. 🐾
                  </p>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: INK_SOFT,
                        border: `2px dashed ${LINE}`, borderRadius: R_PILL, padding: "4px 11px" }}>🚪 INGANG</span>
                      {route.stops.map((s, i) => (
                        <span key={s.zone.id} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                          <span aria-hidden="true" style={{ color: "#C7A98F", fontWeight: 800 }}>→</span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 800,
                            letterSpacing: "0.06em", color: INK, background: RICE, borderRadius: R_PILL, padding: "4px 11px", boxShadow: SHADOW_SOFT }}>
                            <span style={{ color: MATCHA_DP, fontVariantNumeric: "tabular-nums" }}>{String(i + 1).padStart(2, "0")}</span>
                            {s.zone.emoji} {s.zone.label}
                          </span>
                        </span>
                      ))}
                      <span aria-hidden="true" style={{ color: "#C7A98F", fontWeight: 800 }}>→</span>
                      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: INK_SOFT,
                        border: `2px dashed ${LINE}`, borderRadius: R_PILL, padding: "4px 11px" }}>🛒 KASSA'S</span>
                    </div>
                    <p style={{ fontSize: 12.5, color: INK_SOFT, margin: "12px 0 0", lineHeight: 1.6, borderLeft: `3px solid ${BLUSH}`, paddingLeft: 12 }}>
                      Gesorteerd op looprichting: vers eerst, diepvries als laatste. Eén rondje, geen teruglopen.
                    </p>
                    <button className="kg-ich-btn" onClick={() => setShowRoute(true)}
                      style={{ width: "100%", marginTop: 14, background: `linear-gradient(150deg, ${SAKURA}, ${AZUKI})`,
                        color: "#fff", border: "none", borderRadius: R_PILL, fontSize: 14.5, fontWeight: 800,
                        padding: "12px 20px", boxShadow: "0 8px 18px rgba(214,91,120,.34)" }}>
                      🗺️ Bekijk plattegrond · Jumbo Gent
                    </button>
                  </>
                )}
              </section>
            </div>
          </div>

          {/* ═══ RECEPTENBIBLIOTHEEK — the picker that fills the weekmenu ═══ */}
          <section ref={libRef} style={{ scrollMarginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 4 }}>
            <div>
              <div style={{ fontSize: 13.5, letterSpacing: "0.2em", textTransform: "uppercase", color: SAKURA_DP, fontWeight: 800 }}>
                Recepten­bibliotheek
              </div>
              <h2 style={{ fontFamily: F_DISPLAY, fontSize: 28, fontWeight: 800, color: G_TEXT, margin: "2px 0 0" }}>
                Kies je gerechten
              </h2>
            </div>
            <span style={{ fontSize: 14, color: G_MUTED, fontWeight: 600 }}>{loaded ? `${shown.length} recepten` : "laden…"}</span>
          </div>
          <p style={{ fontSize: 14, color: G_MUTED, margin: "6px 0 18px" }}>
            Kies tot {MAX_DINNERS} diners voor je week (hetzelfde gerecht mag meerdere dagen).
            Het weekmenu, de boodschappenlijst en de looproute hierboven groeien mee. 🍱
          </p>

          {/* keyword search */}
          <div style={{ position: "relative", marginBottom: 16 }}>
            <span aria-hidden="true" style={{ position: "absolute", left: 16, top: "50%",
              transform: "translateY(-50%)", fontSize: 15, pointerEvents: "none" }}>🔍</span>
            <input type="text" className="kg-ich-search-input" value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Zoek op naam, ingrediënt of tag…" />
            {search && (
              <button className="kg-ich-btn" onClick={() => setSearch("")} aria-label="zoekopdracht wissen"
                style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  width: 26, height: 26, borderRadius: "50%", border: "none", background: "transparent",
                  color: INK_SOFT, fontSize: 14, lineHeight: 1 }}>
                ✕
              </button>
            )}
          </div>

          {/* main-ingredient filter chips (meat / chicken / fish / veg) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: G_MUTED, marginRight: 2 }}>🍽️ Soort</span>
            {CATEGORY_FILTERS.map(c => {
              const on = cat === c.key;
              return (
                <button key={c.key} className="kg-ich-chip" onClick={() => setCat(c.key)}
                  style={{ background: on ? SAKURA : "#fff", border: "none", borderRadius: R_PILL,
                    color: on ? "#fff" : INK_SOFT, fontSize: 14, fontWeight: 800, padding: "8px 15px",
                    boxShadow: on ? "0 6px 14px rgba(242,109,139,.30)" : SHADOW_SOFT }}>
                  {c.emoji ? `${c.emoji} ${c.label}` : c.label}
                </button>
              );
            })}
          </div>

          {/* tag filter chips */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {tags.map(t => {
              const on = tag === t;
              return (
                <button key={t} className="kg-ich-chip" onClick={() => setTag(t)}
                  style={{ background: on ? SAKURA : "#fff", border: "none", borderRadius: R_PILL,
                    color: on ? "#fff" : INK_SOFT, fontSize: 14, fontWeight: 800, padding: "8px 15px",
                    boxShadow: on ? "0 6px 14px rgba(242,109,139,.30)" : SHADOW_SOFT }}>
                  {t === "all" ? "Alle" : t}
                </button>
              );
            })}
          </div>

          {/* time filter chips */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 22 }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: G_MUTED, marginRight: 2 }}>⏱ Bereidingstijd</span>
            {TIME_BUCKETS.map(b => {
              const on = timeMax === b.max;
              return (
                <button key={b.key} className="kg-ich-chip" onClick={() => setTimeMax(b.max)}
                  style={{ background: on ? MATCHA : "#fff", border: "none", borderRadius: R_PILL,
                    color: on ? "#fff" : INK_SOFT, fontSize: 14, fontWeight: 800, padding: "8px 15px",
                    boxShadow: on ? "0 6px 14px rgba(95,174,119,.30)" : SHADOW_SOFT }}>
                  {b.label}
                </button>
              );
            })}
          </div>

          {removeNote && (
            <div style={{ background: "#FFF0E6", color: SAKURA_DP, fontSize: 14, fontWeight: 700,
              borderRadius: R_MD, padding: "10px 16px", marginBottom: 18, boxShadow: SHADOW_SOFT }}>
              {removeNote}
            </div>
          )}

          {!loaded && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "56px 0", color: G_MUTED }}>
              <Mascot type="matcha" size={78} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>Matcha-kun haalt de recepten op…</span>
            </div>
          )}
          {loaded && shown.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "56px 0", color: G_MUTED }}>
              <Mascot type="onigiri" size={72} bob={false} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>Geen recepten gevonden 🍙</span>
            </div>
          )}

          {/* recipe grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
            {shown.map(r => {
              const count  = countOf(r.id);
              const inPlan = count > 0;
              const full   = selected.length >= MAX_DINNERS;
              const cz     = cuisineOf(r.cuisine);
              const time   = r.totalTime || r.prepTime;
              return (
                <article key={r.id} className="kg-ich-card"
                  style={{ background: CARD, borderRadius: R_LG, overflow: "hidden",
                    display: "flex", flexDirection: "column",
                    boxShadow: inPlan ? `0 0 0 3px ${SAKURA}, ${SHADOW_SOFT}` : SHADOW_SOFT }}>
                  {/* real HelloFresh photo; falls back to the pastel emoji placeholder if absent/broken */}
                  <div style={{ position: "relative", height: 118, overflow: "hidden",
                    background: `linear-gradient(150deg, ${cz.a}, ${cz.b})`,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 60, filter: "drop-shadow(0 4px 8px rgba(150,110,80,.25))" }}>{cz.emoji}</span>
                    {r.image && (
                      <img src={r.image} alt={r.title} loading="lazy"
                        onError={e => { e.currentTarget.style.display = "none"; }}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                    )}
                    <span style={{ position: "absolute", top: 12, left: 12, fontSize: 13.5, fontWeight: 800,
                      color: INK, background: "rgba(255,255,255,.82)", borderRadius: R_PILL, padding: "4px 11px",
                      boxShadow: SHADOW_SOFT }}>⏱ {time}′</span>
                    {/* add / count control — in plan? a [− N +] stepper so the same
                        dish can fill several days; otherwise a single + to add it */}
                    {inPlan ? (
                      <div style={{ position: "absolute", top: 10, right: 10, display: "flex", alignItems: "center",
                        gap: 6, background: SAKURA, borderRadius: R_PILL, padding: "4px 6px", boxShadow: SHADOW_SOFT }}>
                        <button className="kg-ich-btn" onClick={() => removeOneOf(r.id)}
                          title="Eén dag minder" aria-label={`Eén "${r.title}" uit bento`}
                          style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.9)",
                            color: AZUKI, fontSize: 17, fontWeight: 800, lineHeight: 1, cursor: "pointer" }}>–</button>
                        <span style={{ minWidth: "1.2ch", textAlign: "center", color: "#fff", fontSize: 14, fontWeight: 800,
                          fontVariantNumeric: "tabular-nums" }}>{count}</span>
                        <button className="kg-ich-btn" onClick={() => addToPlan(r.id)} disabled={full}
                          title={full ? `Max ${MAX_DINNERS} diners` : "Nog een dag"} aria-label={`Nog een "${r.title}" in bento`}
                          style={{ width: 26, height: 26, borderRadius: "50%", border: "none",
                            background: full ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.9)",
                            color: full ? "#D8907F" : SAKURA_DP, fontSize: 17, fontWeight: 800, lineHeight: 1,
                            cursor: full ? "not-allowed" : "pointer" }}>+</button>
                      </div>
                    ) : (
                      <button className="kg-ich-btn" onClick={() => addToPlan(r.id)} disabled={full}
                        title={full ? `Max ${MAX_DINNERS} diners` : "In m'n bento"}
                        style={{ position: "absolute", top: 10, right: 10, width: 38, height: 38, borderRadius: "50%",
                          border: "none", background: "#fff",
                          color: full ? "#D8C4B0" : SAKURA_DP, fontSize: 20, lineHeight: 1, fontWeight: 800,
                          boxShadow: SHADOW_SOFT, cursor: full ? "not-allowed" : "pointer", opacity: full ? 0.6 : 1 }}>
                        +
                      </button>
                    )}
                  </div>
                  {/* body — dense: full title only */}
                  <div style={{ padding: "10px 12px 12px", display: "flex", alignItems: "flex-start",
                    justifyContent: "space-between", gap: 6, flex: 1 }}>
                    <h3 className="kg-ich-title" onClick={() => setDetail(r)}
                      style={{ fontFamily: F_DISPLAY, fontSize: 15, fontWeight: 800, color: INK, lineHeight: 1.25, margin: 0 }}>
                      {r.title}
                    </h3>
                    <button className="kg-ich-btn kg-ich-remove" onClick={() => handleRemove(r)}
                      title="Verwijderen" aria-label={`"${r.title}" verwijderen`}>
                      ×
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          </section>
        </div>
      </div>

      {/* ── Recipe detail modal (with Cooking mode timeline) ── */}
      {detail && <RecipeModal recipe={detail} servings={servings} count={countOf(detail.id)}
        canAdd={selected.length < MAX_DINNERS} onAdd={() => addToPlan(detail.id)}
        onRemoveOne={() => removeOneOf(detail.id)} onClose={() => setDetail(null)} />}

      {/* ── Route map modal — shopping list re-ordered along the Jumbo Gent path ── */}
      {showRoute && <RouteModal items={shoppingList} servings={servings} onClose={() => setShowRoute(false)} />}
    </div>
  );
}

// Recipe detail modal — Cooking mode (time-oriented) on top, then ingredients.
function RecipeModal({ recipe: r, servings, count, canAdd, onAdd, onRemoveOne, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const scale = servings / (r.servings || servings || 1);
  const cz = cuisineOf(r.cuisine);
  const inPlan = count > 0;
  const t = cookTiming(r);
  const activeFlex = t.active || 1;
  const passiveFlex = t.passive;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(75,59,66,.42)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24, animation: "ichFade .18s ease" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 700, maxWidth: "100%", maxHeight: "90vh", background: CARD,
        borderRadius: R_LG, overflow: "hidden", display: "flex", flexDirection: "column",
        animation: "ichPop .2s ease", boxShadow: "0 26px 70px rgba(150,110,80,.40)", fontFamily: F_ROUND, color: INK }}>
        {/* modal header — pastel food banner */}
        <div style={{ position: "relative", padding: "20px 24px",
          background: `linear-gradient(150deg, ${cz.a}, ${cz.b})` }}>
          <button className="kg-ich-btn" onClick={onClose} aria-label="sluiten"
            style={{ position: "absolute", top: 14, right: 16, width: 34, height: 34, borderRadius: "50%",
              background: "rgba(255,255,255,.85)", border: "none", color: INK, fontSize: 16, lineHeight: 1,
              fontWeight: 800, boxShadow: SHADOW_SOFT }}>✕</button>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 46, filter: "drop-shadow(0 4px 8px rgba(150,110,80,.25))" }}>{cz.emoji}</span>
            <div style={{ minWidth: 0, paddingRight: 40 }}>
              <h2 style={{ fontFamily: F_DISPLAY, fontSize: 22, fontWeight: 800, color: INK, lineHeight: 1.2, margin: 0 }}>{r.title}</h2>
              <div style={{ fontSize: 14, color: "rgba(91,71,80,.8)", marginTop: 3, fontWeight: 600 }}>{r.subtitle}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: SAKURA_DP, background: "rgba(255,255,255,.7)", borderRadius: R_PILL, padding: "4px 12px" }}>{r.cuisine}</span>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: INK, background: "rgba(255,255,255,.7)", borderRadius: R_PILL, padding: "4px 12px" }}>👥 {servings} porties</span>
            {(r.tags || []).map(t2 => (
              <span key={t2} style={{ fontSize: 13.5, fontWeight: 700, color: INK_SOFT, background: "rgba(255,255,255,.55)", borderRadius: R_PILL, padding: "4px 12px" }}>{t2}</span>
            ))}
          </div>
        </div>

        {/* modal body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "22px 24px 24px",
          display: "flex", flexDirection: "column", gap: 18 }}>

          {/* ── COOKING MODE ── */}
          <div style={{ fontFamily: F_DISPLAY, fontSize: 15, fontWeight: 800, color: MATCHA_DP,
            display: "flex", alignItems: "center", gap: 8 }}>
            🔥 Cooking mode <span style={{ fontFamily: F_ROUND, fontSize: 13.5, fontWeight: 600, color: INK_SOFT }}>: elke fase, elke minuut</span>
          </div>

          {/* total + split bar */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: INK_SOFT }}>Totale tijd</div>
              <div style={{ fontFamily: F_DISPLAY, fontSize: 38, fontWeight: 800, color: SAKURA_DP, lineHeight: 1 }}>
                {t.total}<span style={{ fontFamily: F_ROUND, fontSize: 14, fontWeight: 600, color: INK_SOFT }}> min</span>
              </div>
            </div>
            <div role="img" aria-label={`${t.active} minuten actief, ${t.passive} minuten wachten`}
              style={{ display: "flex", gap: 4, flex: 1, minWidth: 240, height: 44, borderRadius: R_PILL,
                overflow: "hidden", boxShadow: SHADOW_SOFT }}>
              <div style={{ flex: activeFlex, background: SAKURA, display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 13.5, fontWeight: 800, whiteSpace: "nowrap" }}>{t.active}′ actief</div>
              {passiveFlex > 0 && (
                <div style={{ flex: passiveFlex, background: RAMUNE, display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#2E6E77", fontSize: 13.5, fontWeight: 800, whiteSpace: "nowrap" }}>{t.passive}′ wachten</div>
              )}
            </div>
          </div>

          {/* parallel-work tip */}
          {t.tip && (
            <div style={{ background: "#FFF7E6", borderRadius: R_MD, padding: "13px 16px", fontSize: 14, color: INK,
              boxShadow: SHADOW_SOFT, lineHeight: 1.5 }}>
              💡 <b style={{ color: SAKURA_DP }}>Parallel:</b> {t.tip}
            </div>
          )}

          {/* per-phase step timeline */}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {t.steps.map((s, i) => {
              const passive = s.mode === "passive";
              return (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, background: RICE,
                  borderRadius: R_MD, padding: "12px 14px" }}>
                  <span style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: "50%", background: MATCHA,
                    color: "#fff", fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600, color: INK, lineHeight: 1.4, whiteSpace: "pre-wrap" }}>{s.text}</span>
                  {s.minutes != null && (
                    <span style={{ flex: "0 0 auto", fontSize: 14, fontWeight: 800, padding: "6px 12px", borderRadius: R_PILL,
                      whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                      background: passive ? "#E4F3F5" : "#FFE3EA", color: passive ? RAMUNE_DP : SAKURA_DP }}>
                      {s.minutes}′{passive ? " wachten" : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <p style={{ fontSize: 13.5, color: INK_SOFT, margin: 0, lineHeight: 1.6 }}>
            <b style={{ color: INK }}>Roze = handen bezig, blauw = je bent vrij.</b> Per-fase tijden zijn een schatting uit het recept, pas ze gerust aan.
          </p>

          {/* ── INGREDIËNTEN ── */}
          <div style={{ fontFamily: F_DISPLAY, fontSize: 15, fontWeight: 800, color: MATCHA_DP, marginTop: 4 }}>🧂 Ingrediënten</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: "4px 20px" }}>
            {(r.ingredients || []).map((ing, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14, color: INK,
                padding: "8px 0", borderBottom: `1px solid ${LINE}` }}>
                <span style={{ fontWeight: 600 }}>{ing.name}</span>
                <span style={{ fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {fmtQty((Number(ing.qty) || 0) * scale)} {ing.unit}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* modal footer */}
        <div style={{ flexShrink: 0, padding: "16px 24px", borderTop: `1px solid ${LINE}`, display: "flex",
          alignItems: "center", justifyContent: inPlan ? "space-between" : "flex-end", gap: 12, background: "#FFFDFB" }}>
          {inPlan && (
            <span style={{ fontSize: 14, fontWeight: 700, color: INK_SOFT }}>
              {count}× in je bento{count > 1 ? " · meerdere dagen 🍱" : ""}
            </span>
          )}
          {inPlan ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: SAKURA, borderRadius: R_PILL,
              padding: "6px 8px", boxShadow: SHADOW_SOFT }}>
              <button className="kg-ich-btn" onClick={onRemoveOne} aria-label="één dag minder"
                style={{ width: 32, height: 32, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.9)",
                  color: AZUKI, fontSize: 19, fontWeight: 800, lineHeight: 1, cursor: "pointer" }}>–</button>
              <span style={{ minWidth: "2.2ch", textAlign: "center", color: "#fff", fontSize: 15, fontWeight: 800,
                fontVariantNumeric: "tabular-nums" }}>{count}</span>
              <button className="kg-ich-btn" onClick={onAdd} disabled={!canAdd}
                title={canAdd ? "Nog een dag" : `Bento vol (${MAX_DINNERS})`} aria-label="nog een dag"
                style={{ width: 32, height: 32, borderRadius: "50%", border: "none",
                  background: canAdd ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.5)",
                  color: canAdd ? SAKURA_DP : "#D8907F", fontSize: 19, fontWeight: 800, lineHeight: 1,
                  cursor: canAdd ? "pointer" : "not-allowed" }}>+</button>
            </div>
          ) : (
            <button className="kg-ich-btn" onClick={onAdd} disabled={!canAdd}
              style={{ background: canAdd ? SAKURA : "#F3E6D6", border: "none", borderRadius: R_PILL,
                color: canAdd ? "#fff" : "#C7A98F", fontSize: 14, fontWeight: 800,
                padding: "12px 22px", boxShadow: canAdd ? SHADOW_SOFT : "none",
                cursor: canAdd ? "pointer" : "not-allowed" }}>
              {canAdd ? "In m'n bento +" : `Bento vol (${MAX_DINNERS})`}
            </button>
          )}
        </div>
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

// Route map modal — the aggregated shopping list re-ordered along the real Jumbo
// Foodmarkt Gent walking path (fresh perimeter → dry grid → diepvries → kassa).
function RouteModal({ items, servings, onClose }) {
  const [checked, setChecked] = useState(() => new Set());
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const route = useMemo(() => buildRoute(items, STORE), [items]);
  const svg = useMemo(() => buildFloorplanSVG(route), [route]);
  const overig = route.stops.find(s => s.zone.id === "overig");
  const toggle = key => setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 85, background: "rgba(75,59,66,.42)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24, animation: "ichFade .18s ease" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 1080, maxWidth: "100%", maxHeight: "92vh", background: CARD,
        borderRadius: R_LG, overflow: "hidden", display: "flex", flexDirection: "column",
        animation: "ichPop .2s ease", boxShadow: "0 26px 70px rgba(150,110,80,.40)", fontFamily: F_ROUND, color: INK }}>
        <div style={{ position: "relative", padding: "18px 24px", background: `linear-gradient(150deg, ${SAKURA}, ${AZUKI})`, color: "#fff" }}>
          <button className="kg-ich-btn" onClick={onClose} aria-label="sluiten"
            style={{ position: "absolute", top: 14, right: 16, width: 34, height: 34, borderRadius: "50%",
              background: "rgba(255,255,255,.85)", border: "none", color: INK, fontSize: 16, lineHeight: 1, fontWeight: 800 }}>×</button>
          <div style={{ fontFamily: F_DISPLAY, fontSize: 20, fontWeight: 800 }}>🗺️ Looproute · Jumbo Foodmarkt Gent</div>
          <div style={{ fontSize: 13.5, opacity: .95, marginTop: 2 }}>
            {route.total} items · {route.stops.length} {route.stops.length === 1 ? "halte" : "haltes"} · {servings}p
            {overig ? ` · ${overig.items.length} onbekend ❓` : ""}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid",
          gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)", gap: 20, padding: 22 }}>
          <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: R_MD, padding: 12, alignSelf: "start" }}
            dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            {route.stops.map((s, i) => (
              <div key={s.zone.id} style={{ border: `1px solid ${LINE}`, borderRadius: 14, padding: "11px 13px", marginBottom: 10, background: "#FFFCF8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 800, fontFamily: F_DISPLAY, fontSize: 15 }}>
                  <span style={{ flex: "0 0 24px", width: 24, height: 24, borderRadius: "50%", background: SAKURA, color: "#fff",
                    fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(255,157,178,.5)" }}>{i + 1}</span>
                  {s.zone.emoji} {s.zone.label}
                  <span style={{ marginLeft: "auto", fontSize: 12, color: INK_SOFT, fontWeight: 700 }}>{s.items.length}×</span>
                </div>
                <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
                  {s.items.map((it, j) => {
                    const key = `${i}_${j}`; const on = checked.has(key);
                    return (
                      <li key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, padding: "3px 0" }}>
                        <input type="checkbox" checked={on} onChange={() => toggle(key)} style={{ accentColor: MATCHA_DP, width: 15, height: 15 }} />
                        <span onClick={() => toggle(key)} style={{ flex: 1, cursor: "pointer", color: on ? INK_SOFT : INK, textDecoration: on ? "line-through" : "none" }}>{it.name}</span>
                        {it.qty ? <span style={{ fontSize: 13, fontWeight: 800, color: SAKURA_DP, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtQty(it.qty)} {it.unit}</span> : null}
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

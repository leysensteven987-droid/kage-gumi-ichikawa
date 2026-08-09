/**
 * pantry.js — Ichikawa's home stock: what is already in the kitchen.
 *
 * The point of the pantry is one question asked in the aisle: "do I actually
 * need this, or is it still in the cupboard from last week?" Everything here
 * serves that:
 *
 *   stockKey(name, unit)          → the identity an ingredient keeps across
 *                                   recipes and across weeks
 *   planShopping(list, stock)     → splits a week list into TO BUY vs COVERED
 *   addStock / takeStock          → shopping put away · a dish cooked
 *   ageOf(item, today)            → how long it has sat, vs its zone's shelf life
 *
 * MATCHING. Corpus ingredient names are HelloFresh-shaped ("(s) Ui",
 * "[Plantaardige] boter", "naar smaak Peper en zout"), so a raw name+unit key
 * would never match the same thing bought two weeks apart. The key therefore
 * runs the SAME normalize() the route engine uses, plus a unit-alias table
 * (gram/g/gr → g, stuks/st → stuk). LANGUAGE SPLIT holds as everywhere else:
 * the aliases and keywords are Dutch because the ingredient data is; only the
 * labels this module exports are English.
 *
 * QUANTITY, and the one rule worth remembering:
 *   qty is a number ≥ 0, or NULL meaning "have some, amount unknown".
 * A recipe line with no measurable amount ("naar smaak Peper en zout") stocks
 * as null; null never depletes when you cook, and it always covers the line.
 * That is exactly how a spice rack behaves, and it keeps salt off the list
 * forever after the first purchase.
 */
import { normalize, classify } from "./jumboRoute.js";

// Unit spellings that mean the same shelf. Dutch — these match ingredient DATA.
const UNIT_ALIAS = {
  g: "g", gr: "g", gram: "g", grammen: "g",
  kg: "kg", kilo: "kg",
  ml: "ml", cl: "cl", l: "l", liter: "l", lt: "l",
  el: "el", eetlepel: "el", eetlepels: "el",
  tl: "tl", theelepel: "tl", theelepels: "tl",
  stuk: "stuk", stuks: "stuk", st: "stuk", stk: "stuk",
  teen: "teen", tenen: "teen", teentje: "teen", teentjes: "teen",
  zakje: "zakje", zakjes: "zakje",
  blik: "blik", blikje: "blik", blikjes: "blik",
  pak: "pak", pakken: "pak", pakje: "pak", pakjes: "pak",
  bos: "bos", bosje: "bos", bosjes: "bos",
  krop: "krop", bol: "bol", bollen: "bol",
  snuf: "snuf", snufje: "snuf",
  plak: "plak", plakken: "plak", plakje: "plak", plakjes: "plak",
};

export function normUnit(u) {
  const s = String(u ?? "").toLowerCase().trim();
  if (!s) return "";
  return UNIT_ALIAS[s] || s;
}

// The identity a pantry line keeps. Falls back to the plain lowercased name
// when normalize() strips everything (a name that was only a quantity).
export function stockKey(name, unit) {
  const raw = String(name ?? "").trim();
  const n = normalize(raw) || raw.toLowerCase();
  return `${n}__${normUnit(unit)}`;
}

// Shelf life in days, per store zone — how long a thing plausibly keeps at
// home. Deliberately conservative for fresh, generous for dry: this only ever
// raises a "check this" flag, it never deletes stock behind your back.
const SHELF_LIFE = {
  vis: 2,
  bakkerij: 3,
  beenhouwerij: 3,
  "groente-fruit": 6,
  charcuterie: 7,
  zuivel: 10,
  veggie: 10,
  overig: 14,
  kaas: 21,
  "ontbijt-beleg": 45,
  diepvries: 90,
  "snoep-noten": 120,
  dranken: 180,
  "wereld-oosters": 180,
  "pasta-rijst": 365,
  "kruiden-conserven": 365,
  "non-food": 3650,
};
const DEFAULT_LIFE = 14;

export function shelfLifeDays(zoneId) {
  return SHELF_LIFE[zoneId] ?? DEFAULT_LIFE;
}

// Local calendar day as YYYY-MM-DD (never UTC — "today" is where the kitchen is).
export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Whole days from ISO date a to ISO date b. Parsed as UTC midnights so DST
// never turns a 7-day-old jar into 6.96 days.
export function daysBetween(a, b) {
  const t0 = Date.parse(`${a}T00:00:00Z`);
  const t1 = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  return Math.round((t1 - t0) / 86400000);
}

// How long this line has sat, against what its zone can take.
// stale = past its window · soon = inside the last fifth of it (min 1 day).
export function ageOf(item, today, store) {
  const zone = store ? classify(item.name, store) : "overig";
  const life = shelfLifeDays(zone);
  const days = item.added ? Math.max(0, daysBetween(item.added, today)) : 0;
  const warnAt = Math.max(1, life - Math.max(1, Math.round(life / 5)));
  return { zone, life, days, stale: days > life, soon: !(days > life) && days >= warnAt };
}

const round2 = (n) => Math.round(n * 100) / 100;
const EPS = 0.009; // below this a remainder is rounding noise, not a shopping line

export function pantryIndex(items) {
  const m = new Map();
  for (const it of items || []) {
    if (!it || !it.name) continue;
    m.set(stockKey(it.name, it.unit), it);
  }
  return m;
}

/**
 * Split a week's shopping list against what is already at home.
 *
 * Returns { toBuy, covered }. Rows in BOTH carry `want` (what the week needs)
 * and `have` (what the pantry holds, null = unmeasured). A toBuy row's `qty` is
 * REWRITTEN to the shortfall — so the route engine, the aisle checklist and the
 * floorplan sheet all show what to actually put in the trolley, untouched.
 */
export function planShopping(list, stock) {
  const idx = pantryIndex(stock);
  const toBuy = [], covered = [];
  for (const it of list || []) {
    const held = idx.get(stockKey(it.name, it.unit));
    const have = held ? (held.qty == null ? null : Number(held.qty) || 0) : 0;
    const want = Number(it.qty) || 0;
    // Unmeasured stock ("have olive oil") covers the line whatever the amount:
    // you do not re-buy oil because the recipe asked for 1 el of it.
    if (have === null) { covered.push({ ...it, want, have: null, need: 0 }); continue; }
    if (want <= 0) {
      // Unmeasured NEED ("naar smaak peper en zout") — any stock at all covers it.
      (have > 0 ? covered : toBuy).push({ ...it, want: 0, have, need: 0 });
      continue;
    }
    const need = round2(Math.max(0, want - have));
    if (need > EPS) toBuy.push({ ...it, qty: need, want, have: round2(Math.min(have, want)), need });
    else covered.push({ ...it, want, have: round2(have), need: 0 });
  }
  return { toBuy, covered };
}

/**
 * Put shopping away: fold lines into stock, refreshing the clock on what was
 * topped up. A line with no measurable qty becomes null ("have some"), and a
 * null already on the shelf stays null — you cannot make "some salt" numeric by
 * buying more of it.
 */
export function addStock(stock, lines, today) {
  const out = [...(stock || [])];
  const at = new Map(out.map((it, i) => [stockKey(it.name, it.unit), i]));
  for (const ln of lines || []) {
    const name = String(ln?.name ?? "").trim();
    if (!name) continue;
    const unit = String(ln?.unit ?? "").trim();
    const add = Number(ln?.qty);
    const key = stockKey(name, unit);
    const i = at.get(key);
    if (i == null) {
      out.push({ name, unit, qty: Number.isFinite(add) && add > 0 ? round2(add) : null, added: today });
      at.set(key, out.length - 1);
    } else {
      const cur = out[i];
      const qty = cur.qty == null || !Number.isFinite(add) || add <= 0
        ? null                                   // unmeasured on either side stays unmeasured
        : round2((Number(cur.qty) || 0) + add);
      out[i] = { ...cur, qty, added: today };
    }
  }
  return out;
}

/**
 * Cook a dish: draw its ingredients down. Numeric stock decrements and drops off
 * the shelf when it hits zero; null stock (the spice rack) is never consumed.
 * Lines with no measurable amount take nothing.
 */
export function takeStock(stock, lines) {
  const out = [...(stock || [])];
  const at = new Map(out.map((it, i) => [stockKey(it.name, it.unit), i]));
  for (const ln of lines || []) {
    const take = Number(ln?.qty);
    if (!Number.isFinite(take) || take <= 0) continue;
    const i = at.get(stockKey(ln?.name, ln?.unit));
    if (i == null) continue;
    const cur = out[i];
    if (cur.qty == null) continue;
    const left = round2((Number(cur.qty) || 0) - take);
    out[i] = { ...cur, qty: left > EPS ? left : 0 };
  }
  return out.filter((it) => it.qty == null || it.qty > EPS);
}

// Set one line to an exact amount (the pantry sheet's ± steppers and the
// "have some" toggle). qty null = unmeasured; ≤ 0 removes the line.
export function setStock(stock, key, qty, today) {
  const out = [];
  let hit = false;
  for (const it of stock || []) {
    if (stockKey(it.name, it.unit) !== key) { out.push(it); continue; }
    hit = true;
    if (qty != null && qty <= EPS) continue; // dropped
    out.push({ ...it, qty: qty == null ? null : round2(qty), added: today || it.added });
  }
  return hit ? out : stock || [];
}

export function removeStock(stock, key) {
  return (stock || []).filter((it) => stockKey(it.name, it.unit) !== key);
}

// Scale a recipe's ingredients to the planned servings — the same maths the
// shopping list does, reused so "cooked it" draws down exactly what was bought.
export function recipeLines(recipe, servings) {
  if (!recipe) return [];
  const scale = servings / (recipe.servings || servings || 1);
  return (recipe.ingredients || [])
    .filter((ing) => (ing?.name || "").trim())
    .map((ing) => ({
      name: ing.name.trim(),
      unit: (ing.unit || "").trim(),
      qty: Number(ing.qty) ? round2(Number(ing.qty) * scale) : null,
    }));
}

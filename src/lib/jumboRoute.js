/**
 * jumboRoute.js — Ichikawa's route engine for Jumbo Foodmarkt Gent.
 *
 * Turns a flat shopping list into a walk-ordered route across the store:
 *   normalize(name) → strip HelloFresh quantity/plural artifacts
 *   classify(name)  → bucket into a store zone via the keyword lexicon
 *   buildRoute(items, store) → ordered stops (walkOrder) + the path polyline
 *
 * Store geometry + lexicon live in data/ichikawa/jumbo-gent-store.json. This is
 * the single source of truth; the standalone _output/ route-map HTML inlines a
 * copy of this logic (kept in sync by hand — small + rarely changes).
 */

// Strip HelloFresh quantity/plural artifacts so a name matches the lexicon.
// "½ stuk(s) rode peper" → "rode peper" · "ras el hanout" keeps its middle "el".
export function normalize(raw) {
  let s = (raw || "").toLowerCase();
  s = s.replace(/[\[\]]/g, " ");                        // keep bracket inner content
  s = s.replace(/\((?:s|ken|len|tjes|nen|n)\)/g, " ");  // plural markers: stuk(s)/pak(ken)/bol(len)
  // strip ONE leading quantity number/fraction, then ONE leading unit word only.
  s = s.replace(/^\s*(?:\d+(?:[.,]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])\s*/, "");
  s = s.replace(
    /^\s*(?:el|tl|stuks?|zakjes?|bosjes?|pak(?:ken)?|blikjes?|blik|teentjes?|teen|head|bollen?|bol|gram|kg|ml|cl|stengels?|plakken?|plak|bakjes?|potjes?|fles|krop|handjes?|scheutjes?)\s+/,
    ""
  );
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, " ").replace(/\d+(?:[.,]\d+)?/g, " "); // any remaining numbers
  s = s.replace(/naar smaak/g, " ");
  s = s.replace(/voor (?:de )?(?:saus|rijst|garnering|erbij)/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// zones sorted by match priority (lower = checked first); first keyword hit wins.
function orderedZones(store) {
  return [...store.zones].sort((a, b) => a.priority - b.priority);
}

// A keyword matches only at a WORD START (string start, or after space/-/‑//).
// This keeps Dutch compounds where the meaningful root is a PREFIX
// (knoflook→knoflookteen, zalm→zalmfilet, kip→kippendijreepjes) while rejecting
// mid-word coincidences ("ui" inside "suiker"/"kruiden"/"bouillon"). Compounds
// whose root is a SUFFIX (roomkaas, karnemelk) are listed explicitly instead.
function wordStartHit(s, kw) {
  let i = s.indexOf(kw);
  while (i !== -1) {
    const before = i === 0 ? "" : s[i - 1];
    if (i === 0 || before === " " || before === "-" || before === "/") return true;
    i = s.indexOf(kw, i + 1);
  }
  return false;
}

export function classify(raw, store) {
  const s = normalize(raw);
  if (!s) return "overig";
  // hard overrides win over the keyword lexicon (e.g. "…bouillon" is always pantry,
  // never the meat counter its kip-/runder- prefix would otherwise match).
  for (const o of store.overrides || []) {
    if (s.includes(o.contains)) return o.zone;
  }
  for (const z of orderedZones(store)) {
    for (const kw of z.keywords) {
      if (wordStartHit(s, kw)) return z.id;
    }
  }
  return "overig";
}

// items: [{ name, qty?, unit? }] (or plain strings). Returns walk-ordered stops.
export function buildRoute(items, store) {
  const byId = Object.fromEntries(store.zones.map((z) => [z.id, z]));
  const stops = new Map(); // zoneId → { zone, items:[] }
  for (const it of items) {
    const name = typeof it === "string" ? it : it.name;
    if (!name || !name.trim()) continue;
    const zid = classify(name, store);
    if (!stops.has(zid)) stops.set(zid, { zone: byId[zid], items: [] });
    stops.get(zid).items.push(typeof it === "string" ? { name } : it);
  }
  // order the visited zones by the store's walking sequence
  const ordered = store.walkOrder
    .filter((zid) => stops.has(zid))
    .map((zid) => stops.get(zid));
  // path: entrance → each visited zone centre → checkout
  const path = [
    { ...store.endpoints.ingang, kind: "ingang" },
    ...ordered.map((s) => ({ id: s.zone.id, cx: s.zone.cx, cy: s.zone.cy, kind: "stop" })),
    { ...store.endpoints.kassa, kind: "kassa" },
  ];
  return { stops: ordered, path, total: items.length };
}

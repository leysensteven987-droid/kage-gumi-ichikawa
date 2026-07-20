// Shared text cleaner for the Ichikawa corpus. HelloFresh JSON-LD embeds raw HTML
// (<p>, <strong>, <ul>/<li>) + HTML entities in instruction/description text, which
// render as literal tag codes in the UI. cleanText() flattens that to readable plain
// text: list items → bullet lines, block tags → newlines, entities decoded.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  deg: '°', hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓', frac23: '⅔',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  auml: 'ä', ccedil: 'ç', iuml: 'ï', icirc: 'î', ouml: 'ö', ocirc: 'ô',
  uuml: 'ü', ucirc: 'û', ugrave: 'ù', ntilde: 'ñ', szlig: 'ß',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', iexcl: '¡',
};

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => Object.prototype.hasOwnProperty.call(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m);
}

export function cleanText(s) {
  if (s == null) return s;
  let t = String(s);
  t = t.replace(/<li[^>]*>/gi, '\n• ');                       // list item → bullet line
  t = t.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr)>/gi, '\n');    // block closers → newline
  t = t.replace(/<br\s*\/?>/gi, '\n');                        // <br> → newline
  t = t.replace(/<[^>]+>/g, '');                              // strip any remaining tags
  t = decodeEntities(t);                                      // &amp; &deg; &frac12; …
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');// trim around newlines
  t = t.replace(/\n{3,}/g, '\n\n');                           // cap blank runs
  t = t.replace(/[ \t]{2,}/g, ' ');                           // collapse runs of spaces
  return t.trim();
}

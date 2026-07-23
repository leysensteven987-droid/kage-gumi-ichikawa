/**
 * @vibe-author STLE @version 1 @date 23JUL26 @comment engine/timing-pass.mjs — LLM per-phase timing enrichment (active/passive minutes + parallelTip) over the recipe corpus
 */

/**
 * timing-pass.mjs
 *
 * Fills the per-phase timing fields the cooking view renders but that the
 * HelloFresh scrape leaves null:
 *   - steps[].minutes  (integer, ≥0)
 *   - steps[].mode     ("active" hands-on | "passive" waiting/cooking)
 *   - activeTime       (integer, sum of active-step minutes)
 *   - parallelTip      (one short Dutch sentence)
 *
 * It calls Claude (structured output) once per recipe, validates the response
 * against the recipe's step count, and writes ONLY those four fields back to
 * each recipe's own JSON file — every other field is preserved byte-for-byte,
 * 2-space-indented + trailing newline (matching enrich-recipes.mjs output).
 *
 * Idempotent: a recipe is a candidate only when keep !== false AND at least one
 * step still has minutes == null. Re-running skips already-enriched recipes.
 *
 * Flags:
 *   --dry-run       compute + print, write nothing
 *   --limit N       process at most N recipes
 *   --id <slug>     process a single recipe by id / filename (implies limit 1)
 *
 * Run:
 *   node engine/timing-pass.mjs --dry-run --limit 2
 *   node engine/timing-pass.mjs --limit 2
 *   node engine/timing-pass.mjs --id butter-chicken-met-rijst-6a1038e9a3fbb74cc4f0b395
 *
 * A machine-readable JSON summary is printed to stdout at the end; progress
 * goes to stderr. Debug/log lines are prefixed [kg:timing].
 *
 * NOTE: standalone dev tool — NOT used by the app runtime. Requires ANTHROPIC_API_KEY (or an
 * `ant` OAuth profile); Anthropic API usage is billed separately from a Claude subscription.
 */

import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Anchor data/ at the repo root regardless of cwd (one level up from engine/).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RECIPES_DIR = path.join(REPO_ROOT, 'data', 'recipes');

const MODEL = 'claude-opus-4-8'; // exact string — do NOT append a date suffix
const POOL_SIZE = 3; // process a few recipes concurrently
const MAX_TOKENS = 2000; // responses are small

const log = (...a) => console.error('[kg:timing]', ...a);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dryRun: false, limit: null, id: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--id') opts.id = argv[++i];
    else if (a.startsWith('--id=')) opts.id = a.slice('--id='.length);
    else log(`ignoring unknown arg: ${a}`);
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) {
    throw new Error(`--limit must be a non-negative integer`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Auth preflight — the SDK resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
// then an `ant auth login` OAuth profile. If none is present, stop cleanly with
// a clear message instead of erroring out mid-run.
// ---------------------------------------------------------------------------
function checkAuth() {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, method: 'env:ANTHROPIC_API_KEY' };
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { ok: true, method: 'env:ANTHROPIC_AUTH_TOKEN' };

  // Try the `ant` CLI's own view of active credentials.
  try {
    const out = execFileSync('ant', ['auth', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/active|profile|logged in|credential/i.test(out)) return { ok: true, method: 'ant-profile' };
  } catch {
    // ant not installed or no active profile — fall through to on-disk check
  }

  // On-disk OAuth profile written by `ant auth login`.
  const cfgDir =
    process.env.ANTHROPIC_CONFIG_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Anthropic')
      : path.join(os.homedir(), '.config', 'anthropic'));
  try {
    const creds = path.join(cfgDir, 'credentials');
    if (fs.existsSync(creds) && fs.readdirSync(creds).some((f) => f.endsWith('.json'))) {
      return { ok: true, method: 'ant-profile-disk' };
    }
  } catch {
    // ignore
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------
function loadRecipeFile(file) {
  const full = path.join(RECIPES_DIR, file);
  try {
    const raw = fs.readFileSync(full, 'utf8');
    return { file, full, data: JSON.parse(raw) };
  } catch (err) {
    log(`skip ${file} — unreadable/invalid JSON (${err.message})`);
    return null;
  }
}

function isUnenriched(data) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length === 0) return false; // nothing to time
  return steps.some((s) => s == null || s.minutes == null);
}

function findCandidates(opts) {
  if (!fs.existsSync(RECIPES_DIR)) {
    throw new Error(`recipes dir not found: ${RECIPES_DIR}`);
  }

  let files;
  if (opts.id) {
    // Accept either a bare id or a filename.
    const base = opts.id.endsWith('.json') ? opts.id : `${opts.id}.json`;
    files = [base];
  } else {
    files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.json')).sort();
  }

  const candidates = [];
  for (const file of files) {
    const rec = loadRecipeFile(file);
    if (!rec) continue;
    const { data } = rec;
    if (data.keep === false) continue; // opt-out recipes
    if (!isUnenriched(data)) continue; // already enriched — idempotent skip
    candidates.push(rec);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Prompt + schema
// ---------------------------------------------------------------------------
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps', 'activeTime', 'parallelTip'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['minutes', 'mode'],
        properties: {
          minutes: { type: 'integer' },
          mode: { type: 'string', enum: ['active', 'passive'] },
        },
      },
    },
    activeTime: { type: 'integer' },
    parallelTip: { type: 'string' },
  },
};

function buildPrompt(data) {
  const steps = data.steps.map((s, i) => `Stap ${i + 1}:\n${(s && s.text) || ''}`).join('\n\n');
  const totalLine =
    data.totalTime != null
      ? `De totale bereidingstijd van dit recept is ongeveer ${data.totalTime} minuten.`
      : `De totale bereidingstijd is onbekend — schat deze zelf redelijk in op basis van de stappen.`;

  return [
    `Je bent een kok die per bereidingsstap de tijd en het type werk inschat voor een receptenapp.`,
    ``,
    `Recept: ${data.title || '(zonder titel)'}`,
    totalLine,
    ``,
    `Hieronder staan ${data.steps.length} genummerde stappen (in het Nederlands):`,
    ``,
    steps,
    ``,
    `Geef voor ELKE stap, in dezelfde volgorde, terug:`,
    `- minutes: een geheel getal (aantal minuten dat de stap kost, ≥ 0).`,
    `- mode: "active" als de stap hands-on werk is (snijden, bakken, roeren, mengen),`,
    `        of "passive" als het vooral wachten/garen is (koken, sudderen, oven, rusten, marineren).`,
    ``,
    `Geef daarnaast op receptniveau:`,
    `- activeTime: een geheel getal, de som van de minuten van alle stappen met mode "active".`,
    `- parallelTip: één korte Nederlandse zin die een handige parallelle actie voorstelt`,
    `  (bijv. "Terwijl de rijst kookt, snijd je alvast de groenten.").`,
    ``,
    `Belangrijk: de som van alle step-minutes moet dicht bij de totale bereidingstijd liggen.`,
    `Lever precies ${data.steps.length} step-objecten aan — niet meer, niet minder.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response coercion / validation
// ---------------------------------------------------------------------------
function coerceMinutes(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function coerceMode(v) {
  return v === 'passive' ? 'passive' : 'active'; // default "active" on anything odd
}

// Returns { steps:[{minutes,mode}], activeTime, parallelTip } or throws on
// step-count mismatch (caller skips the recipe on throw).
function validateAndCoerce(parsed, expectedCount) {
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('response missing steps array');
  }
  if (parsed.steps.length !== expectedCount) {
    throw new Error(`step count mismatch — got ${parsed.steps.length}, expected ${expectedCount}`);
  }
  const steps = parsed.steps.map((s) => ({
    minutes: coerceMinutes(s && s.minutes),
    mode: coerceMode(s && s.mode),
  }));
  // Prefer the model's activeTime; fall back to the derived sum if absent/invalid.
  let activeTime = Math.round(Number(parsed.activeTime));
  if (!Number.isFinite(activeTime) || activeTime < 0) {
    activeTime = steps.filter((s) => s.mode === 'active').reduce((a, s) => a + s.minutes, 0);
  }
  const parallelTip = typeof parsed.parallelTip === 'string' ? parsed.parallelTip.trim() : '';
  return { steps, activeTime, parallelTip };
}

// ---------------------------------------------------------------------------
// One Claude call for one recipe
// ---------------------------------------------------------------------------
async function enrichOne(client, data) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // adaptive thinking is optional; keep it on for the light reasoning here
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: buildPrompt(data) }],
  });

  // Concatenate any text blocks and parse as JSON.
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`response was not valid JSON (${err.message})`);
  }
  const result = validateAndCoerce(parsed, data.steps.length);
  return { result, usage: resp.usage };
}

// ---------------------------------------------------------------------------
// Write-back — mutate ONLY the four owned fields; preserve everything else
// byte-for-byte; 2-space indent + trailing newline.
// ---------------------------------------------------------------------------
function writeBack(full, result) {
  const data = JSON.parse(fs.readFileSync(full, 'utf8')); // re-read to avoid clobbering
  data.steps = data.steps.map((s, i) => ({
    ...s,
    minutes: result.steps[i].minutes,
    mode: result.steps[i].mode,
  }));
  data.activeTime = result.activeTime;
  data.parallelTip = result.parallelTip;
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------
async function runPool(items, size, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      await worker(items[my], my);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let candidates = findCandidates(opts);
  const totalCandidates = candidates.length;
  if (opts.limit != null) candidates = candidates.slice(0, opts.limit);

  log(
    `${totalCandidates} candidate recipe(s) need timing; processing ${candidates.length}` +
      `${opts.dryRun ? ' (DRY RUN — no writes)' : ''}.`
  );

  if (candidates.length === 0) {
    console.log(JSON.stringify({ enriched: 0, skipped: 0, failed: 0, candidates: 0, tokens: null }, null, 2));
    return;
  }

  // Auth preflight before the first real API call.
  const auth = checkAuth();
  if (!auth.ok) {
    log(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login` to ' +
        'create an OAuth profile, then re-run. Stopping before any API call.'
    );
    console.log(
      JSON.stringify(
        {
          error: 'auth_not_configured',
          message:
            'No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and no ant OAuth profile. Set a key or run `ant auth login`.',
          candidates: totalCandidates,
        },
        null,
        2
      )
    );
    process.exitCode = 2;
    return;
  }
  log(`auth OK via ${auth.method}`);

  const client = new Anthropic(); // zero-arg — resolves creds from env or ant profile

  const counts = { enriched: 0, skipped: 0, failed: 0 };
  const tokens = { input: 0, output: 0 };
  const skippedIds = [];
  const failedIds = [];

  await runPool(candidates, POOL_SIZE, async (rec) => {
    const { file, full, data } = rec;
    try {
      const { result, usage } = await enrichOne(client, data);
      if (usage) {
        tokens.input += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        tokens.output += usage.output_tokens || 0;
      }
      if (opts.dryRun) {
        log(
          `DRY ${data.id}: steps=${result.steps
            .map((s) => `${s.minutes}${s.mode[0]}`)
            .join(',')} activeTime=${result.activeTime} tip="${result.parallelTip}"`
        );
      } else {
        writeBack(full, result);
        log(`OK  ${data.id} -> minutes+mode written, activeTime=${result.activeTime}`);
      }
      counts.enriched++;
    } catch (err) {
      if (/step count mismatch/.test(err.message)) {
        log(`SKIP ${data.id} — ${err.message}`);
        counts.skipped++;
        skippedIds.push({ id: data.id, reason: err.message });
      } else {
        log(`FAIL ${file} — ${err.message}`);
        counts.failed++;
        failedIds.push({ id: data.id || file, reason: err.message });
      }
    }
  });

  console.log(
    JSON.stringify(
      {
        dryRun: opts.dryRun,
        candidates: totalCandidates,
        processed: candidates.length,
        enriched: counts.enriched,
        skipped: counts.skipped,
        failed: counts.failed,
        skippedIds,
        failedIds,
        tokens: { input: tokens.input, output: tokens.output, total: tokens.input + tokens.output },
      },
      null,
      2
    )
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[kg:timing] Fatal error:', err);
    process.exit(1);
  });
}

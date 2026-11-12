#!/usr/bin/env node
/**
 * nightly/run.mjs - the night shift for this repo. One plan item per night.
 *
 * Fired by PM2 (cron_restart in this repo's own PM2 file, autorestart:false), or by hand.
 * The SAME file ships in toge, kage-gumi-ichikawa, kage-gumi-tetsu and kage-gumi-raiden;
 * everything app-specific lives in nightly/config.json next to it.
 *
 * Flow:
 *   guard (enabled, PAUSED file, time window, once-a-day, lock, busy processes, free RAM)
 *   -> pick ONE item from nightly/PLAN.md (recurring-due > partial > lane-of-the-night > any)
 *   -> fresh git worktree at .nightly/wt on branch nightly/work (the live tree is never edited)
 *   -> headless `claude -p` on the PERSONAL seat (CLAUDE_CONFIG_DIR = seatDir), brief on stdin
 *   -> runner-side gates in the worktree (build / tests / syntax) - Claude's word is not enough
 *   -> fast-forward main, back up live user data, deploy, smoke the live app
 *   -> smoke red => reset main back, redeploy the old build, smoke again, park the work on a branch
 *   -> push, write nightly/reports/<date>.md, commit + push it, log to KG if available
 *
 * Flags:
 *   --now           ignore the time window and the once-a-day guard (manual run)
 *   --dry-run       guards + item pick + prompt only; no worktree, no Claude, no git writes
 *   --no-deploy     do the work and gates, park it on a branch, never touch main or the live app
 *   --item=<ID>     work this plan item instead of the automatic pick
 *
 * Kill switch: create .nightly/PAUSED (or set "enabled": false in config.json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const ARGV = process.argv.slice(2);
const FLAG = (f) => ARGV.includes(f);
const NOW = FLAG('--now');
const DRY = FLAG('--dry-run');
const NO_DEPLOY = FLAG('--no-deploy');
const ITEM_ARG = (ARGV.find((a) => a.startsWith('--item=')) || '').slice(7);

const STATE = path.join(REPO, '.nightly');
const WT = path.join(STATE, 'wt');
const LOGS = path.join(STATE, 'logs');
const BACKUPS = path.join(STATE, 'backups');
const STATE_FILE = path.join(STATE, 'state.json');
const LOCK = path.join(STATE, 'lock');
const PLAN = path.join(HERE, 'PLAN.md');
const BRIEF = path.join(HERE, 'BRIEF.md');
const REPORTS = path.join(HERE, 'reports');
const WORK_BRANCH = 'nightly/work';
const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const started = new Date();
const pad = (n) => String(n).padStart(2, '0');
const DATE = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
const STAMP = `${DATE}T${pad(started.getHours())}${pad(started.getMinutes())}`;
for (const d of [STATE, LOGS, BACKUPS, REPORTS]) fs.mkdirSync(d, { recursive: true });
const RUN_LOG = path.join(LOGS, `${STAMP}.log`);

// ---------- small helpers ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(RUN_LOG, line + '\n', 'utf8');
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { failures: {}, recurring: {} }; }
}
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8'); }
/** git without a shell; returns { code, out } with trimmed stdout+stderr. */
function git(args, cwd = REPO) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
/** a config command string, through the shell (npm/pm2 are .cmd shims on Windows). */
function run(cmd, cwd, timeoutSec = 600) {
  const t0 = Date.now();
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const code = r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 1) : (r.status ?? 1);
  return { cmd, code, secs: Math.round((Date.now() - t0) / 1000), tail: out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n') };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- report accumulator ----------
const report = { item: null, model: null, outcome: 'NOOP', notes: [], gates: [], deploy: [], smoke: [], claude: null };
const note = (s) => { report.notes.push(s); log(s); };

function writeReport() {
  const r = report;
  const L = [];
  L.push(`# ${CFG.app} night run - ${DATE}`, '');
  L.push(`- **Outcome:** ${r.outcome}`);
  if (r.item) L.push(`- **Item:** ${r.item.id} - ${r.item.title}`);
  if (r.model) L.push(`- **Model:** ${r.model} on the personal seat`);
  if (r.claude) L.push(`- **Claude:** ${r.claude.status} · ${r.claude.minutes} min${r.claude.cost != null ? ` · $${r.claude.cost.toFixed(2)} API-equivalent` : ''}`);
  L.push(`- **Started:** ${started.toISOString()} · **ended:** ${new Date().toISOString()}`, '');
  if (r.notes.length) L.push('## Runner notes', '', ...r.notes.map((n) => `- ${n}`), '');
  if (r.claude?.text) L.push('## What the night did', '', r.claude.text.trim(), '');
  const block = (title, rows) => {
    if (!rows.length) return;
    L.push(`## ${title}`, '');
    for (const g of rows) L.push(`- ${g.code === 0 ? 'PASS' : 'FAIL'} \`${g.cmd}\` (${g.secs}s)${g.code !== 0 && g.tail ? `\n\n  \`\`\`\n${g.tail.split('\n').map((x) => '  ' + x).join('\n')}\n  \`\`\`` : ''}`);
    L.push('');
  };
  block('Gates (worktree)', r.gates);
  block('Deploy', r.deploy);
  block('Live smoke', r.smoke);
  const file = path.join(REPORTS, `${DATE}.md`);
  // Two runs on one day (a manual --now after the night) append instead of clobbering.
  const body = L.join('\n');
  if (fs.existsSync(file)) fs.appendFileSync(file, '\n---\n\n' + body, 'utf8');
  else fs.writeFileSync(file, body, 'utf8');
  return file;
}

// ---------- plan parsing ----------
// Item line:  - [ ] **REL-03** Title text ... `[opus]` `[branch]` `[every:sun]`
//   [ ] open · [~] partial (continued first) · [x] done · [!] blocked, needs Steven
//   [next] = picked before the lane rotation; [hold] = never picked unattended; [branch] = work lands on a branch, never deployed
//   [every:<dow>] = recurring, picked first on that weekday, never ticked
function parsePlan() {
  const lines = fs.readFileSync(PLAN, 'utf8').split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^- \[( |x|~|!)\] \*\*([A-Z][A-Z0-9-]+)\*\*\s*(.*)$/);
    if (m) {
      // Only the known tags count, so a markdown link like [docs](...) is never read as one.
      const TAG = /`?\[(opus|sonnet|hold|branch|next|every:(?:sun|mon|tue|wed|thu|fri|sat))\]`?/g;
      const tags = [...m[3].matchAll(TAG)].map((t) => t[1]);
      cur = { status: m[1], id: m[2], title: m[3].replace(TAG, '').replace(/\s+/g, ' ').trim(), tags, body: [line] };
      cur.lane = cur.id.split('-')[0];
      items.push(cur);
    } else if (cur && (/^\s{2,}\S/.test(line) || line.trim() === '')) {
      cur.body.push(line);
    } else {
      cur = null;
    }
  }
  return items;
}
function pickItem(items, state) {
  if (ITEM_ARG) return items.find((i) => i.id === ITEM_ARG) || null;
  const today = DOW[started.getDay()];
  const fails = state.failures || {};
  const usable = (i) => !i.tags.includes('hold') && (fails[i.id] || 0) < (CFG.maxFailures || 2);
  const due = items.find((i) => usable(i) && i.status === ' ' && i.tags.includes(`every:${today}`) && state.recurring?.[i.id] !== DATE);
  if (due) return due;
  const open = items.filter((i) => usable(i) && !i.tags.some((t) => t.startsWith('every:')));
  const partial = open.find((i) => i.status === '~');
  if (partial) return partial;
  // [next] = Steven's (or the plan's) "do this one first", ahead of the lane rotation.
  const next = open.find((i) => i.status === ' ' && i.tags.includes('next'));
  if (next) return next;
  // Alternate lanes night by night so release work and fine-tuning both move.
  const lanes = CFG.lanes || ['REL', 'TUNE'];
  const dayNo = Math.floor(started.getTime() / 86400000);
  const order = lanes.map((_, k) => lanes[(dayNo + k) % lanes.length]);
  for (const lane of order) {
    const hit = open.find((i) => i.status === ' ' && i.lane === lane);
    if (hit) return hit;
  }
  return open.find((i) => i.status === ' ') || null;
}

// ---------- guards ----------
function inWindow() {
  const [s, e] = CFG.window || [0, 24];
  const h = started.getHours();
  return s <= e ? h >= s && h < e : h >= s || h < e;
}
function busyProcess() {
  const pats = CFG.skipIfProcess || [];
  if (!pats.length) return null;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true });
  for (const row of (r.stdout || '').split(/\r?\n/)) {
    const [pid, cmd = ''] = row.split('\t');
    if (Number(pid) === process.pid || !cmd) continue;
    const hit = pats.find((p) => cmd.toLowerCase().includes(p.toLowerCase()));
    if (hit) return `${hit} (pid ${pid})`;
  }
  return null;
}
function pm2Status(name) {
  const r = spawnSync('pm2 jlist', { shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout).find((p) => p.name === name)?.pm2_env?.status || 'missing'; } catch { return 'unknown'; }
}

// ---------- Claude ----------
function buildPrompt(item) {
  const brief = fs.readFileSync(BRIEF, 'utf8');
  const recent = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.md')).sort().slice(-3).map((f) => `nightly/reports/${f}`);
  const branchOnly = item.tags.includes('branch');
  return [
    brief,
    '',
    '---',
    '',
    `# Tonight - ${DATE} (${DOW[started.getDay()]})`,
    '',
    `- App: **${CFG.app}**. You are working in a git worktree: \`${WT}\` (branch \`${WORK_BRANCH}\`, cut from main).`,
    `- The live repo is \`${REPO}\`. Do not read or write anything there; the runner owns it.`,
    `- After you finish, the runner runs these gates in the worktree: ${(CFG.gates || []).map((g) => `\`${g}\``).join(', ') || '(none)'}.`,
    branchOnly
      ? '- This item is tagged [branch]: your work is parked on a review branch and NOT deployed.'
      : `- If the gates pass, the runner fast-forwards main, deploys to the LIVE app and smoke-tests it (${(CFG.smoke?.http || []).map((h) => h.url).join(', ')}${(CFG.smoke?.cmds || []).length ? ' + ' + CFG.smoke.cmds.join(', ') : ''}). A red smoke rolls your work back.`,
    recent.length ? `- Recent night reports (read them if the item continues earlier work): ${recent.join(', ')}` : '- No earlier night reports yet.',
    '',
    `## Tonight's item: ${item.id}`,
    '',
    item.body.join('\n').trimEnd(),
    '',
    item.status === '~' ? 'This item is PARTIAL - an earlier night started it. Read its notes in PLAN.md and the recent reports, then continue.' : '',
  ].join('\n');
}

function runClaude(prompt, model) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: CFG.seatDir };
    // Bill the personal subscription seat, never an API key; and do not look like a nested session.
    for (const k of Object.keys(env)) {
      if (k === 'ANTHROPIC_API_KEY' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('KG_')) delete env[k];
    }
    const claudeArgs = ['-p', '--model', model, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--max-turns', String(CFG.maxTurns || 200)];
    let cmd = CFG.claudeBin;
    let args = claudeArgs;
    // The beacon makes the run visible on KG's fleet strip; optional, the run works without it.
    if (CFG.beacon && fs.existsSync(CFG.beacon)) {
      cmd = process.execPath;
      args = [CFG.beacon, '--label', `${CFG.app} nightly`, '--tool', 'claude', '--', CFG.claudeBin, ...claudeArgs];
    }
    const outFile = path.join(LOGS, `${STAMP}-claude.jsonl`);
    const out = fs.openSync(outFile, 'w');
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: WT, env, shell: cmd.endsWith('.cmd'), windowsHide: true, stdio: ['pipe', out, out] });
    child.stdin.end(prompt, 'utf8');
    const limitMs = (CFG.timeoutMin || 45) * 60000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`claude over ${CFG.timeoutMin} min - killing the process tree`);
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, limitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      let text = '';
      let cost = null;
      for (const line of fs.readFileSync(outFile, 'utf8').split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') { text = ev.result || text; cost = ev.total_cost_usd ?? cost; }
        } catch { /* beacon / non-JSON lines */ }
      }
      const m = text.match(/NIGHTLY:\s*(DONE|PARTIAL|BLOCKED|NOOP)\b.*$/m);
      resolve({
        code, timedOut, text, cost,
        status: timedOut ? 'TIMEOUT' : m ? m[1] : 'NO-VERDICT',
        minutes: Math.round((Date.now() - t0) / 60000),
      });
    });
  });
}

// ---------- deploy pieces ----------
function backupData() {
  const dest = path.join(BACKUPS, STAMP);
  let n = 0;
  for (const rel of CFG.backup || []) {
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dest, rel), { recursive: true });
    n++;
  }
  // keep the newest N backups
  const keep = CFG.keepBackups || 7;
  const all = fs.readdirSync(BACKUPS).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
  return n ? dest : null;
}
async function smoke(cmdsToo = true) {
  const rows = [];
  await sleep((CFG.smoke?.waitSec || 5) * 1000);
  for (const h of CFG.smoke?.http || []) {
    const t0 = Date.now();
    let status = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(h.url, { headers: h.headers || {}, signal: AbortSignal.timeout(5000) });
        status = res.status;
        if ((h.expect || [200]).includes(status)) break;
      } catch { status = 0; }
      await sleep(3000);
    }
    const ok = (h.expect || [200]).includes(status);
    rows.push({ cmd: `GET ${h.url} -> ${status} (want ${(h.expect || [200]).join('/')})`, code: ok ? 0 : 1, secs: Math.round((Date.now() - t0) / 1000), tail: '' });
  }
  for (const c of cmdsToo ? CFG.smoke?.cmds || [] : []) {
    let r = run(c, REPO, CFG.smoke?.cmdTimeoutSec || 900);
    if (r.code !== 0) { log(`smoke cmd red, one retry: ${c}`); r = run(c, REPO, CFG.smoke?.cmdTimeoutSec || 900); }
    rows.push(r);
  }
  return rows;
}
/** true when package-lock.json differs between two commits (deps must be reinstalled). */
function lockChanged(a, b) {
  return git(['diff', '--name-only', a, b, '--', 'package-lock.json']).out.length > 0;
}
function deploySteps(fromSha, toSha) {
  const rows = [];
  const steps = [...(CFG.deploy?.steps || [])];
  if (CFG.deploy?.install && fromSha && toSha && lockChanged(fromSha, toSha)) steps.unshift(CFG.deploy.install);
  for (const d of steps) {
    const r = run(d, REPO, CFG.deploy?.stepTimeoutSec || 900);
    rows.push(r);
    if (r.code !== 0) break;
  }
  return rows;
}
function parkBranch(suffix) {
  const name = `nightly/${DATE}-${report.item.id.toLowerCase()}${suffix ? '-' + suffix : ''}`;
  const r = git(['push', '--force', 'origin', `${WORK_BRANCH}:refs/heads/${name}`]);
  note(r.code === 0 ? `Work parked on branch \`${name}\` for review.` : `Could not push review branch ${name}: ${r.out.split('\n').pop()}`);
}
function removeWorktree() {
  if (fs.existsSync(WT)) git(['worktree', 'remove', '--force', WT]);
  git(['worktree', 'prune']);
}

// ---------- main ----------
async function main() {
  if (CFG.enabled === false) return log('disabled in config.json - exit');
  if (fs.existsSync(path.join(STATE, 'PAUSED'))) return log('.nightly/PAUSED present - exit');
  const state = readState();
  if (!NOW && !DRY) {
    if (!inWindow()) return log(`outside window ${JSON.stringify(CFG.window)} - exit (PM2 fires once on start; that is this)`);
    if (state.lastRun === DATE) return log(`already ran today (${DATE}) - exit`);
  }
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 4 * 3600000) return log('another night run holds the lock - exit');
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    await shift(state);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

async function shift(state) {
  log(`night shift for ${CFG.app} - ${NOW ? 'manual' : 'scheduled'}${DRY ? ' DRY-RUN' : ''}${NO_DEPLOY ? ' NO-DEPLOY' : ''}`);
  const busy = busyProcess();
  if (busy) { report.outcome = 'SKIPPED'; note(`Skipped: the box is busy with ${busy}.`); return finish(state, false); }
  const freeMb = Math.round(os.freemem() / 1048576);
  if (CFG.minFreeMb && freeMb < CFG.minFreeMb) { report.outcome = 'SKIPPED'; note(`Skipped: ${freeMb} MB free RAM, floor is ${CFG.minFreeMb} MB.`); return finish(state, false); }

  const items = parsePlan();
  const item = pickItem(items, state);
  if (!item) { report.outcome = 'NOOP'; note('No open item the night may take (all done, [hold], or failed twice).'); return finish(state, false); }
  report.item = item;
  const model = MODELS[item.tags.includes('opus') ? 'opus' : CFG.defaultModel || 'sonnet'];
  report.model = model;
  log(`item ${item.id} (${item.status === '~' ? 'partial' : 'open'}) lane ${item.lane} model ${model}`);
  const prompt = buildPrompt(item);
  if (DRY) {
    fs.writeFileSync(path.join(LOGS, `${STAMP}-prompt.md`), prompt, 'utf8');
    log(`DRY-RUN: prompt written to .nightly/logs/${STAMP}-prompt.md (${prompt.length} chars). Gates: ${JSON.stringify(CFG.gates)}. Deploy: ${JSON.stringify(CFG.deploy?.steps)}. pm2 ${CFG.pm2Process}: ${pm2Status(CFG.pm2Process)}`);
    return;
  }

  // Live repo preflight: on main, current with origin.
  const branch = git(['branch', '--show-current']).out;
  if (branch !== (CFG.branch || 'main')) { report.outcome = 'SKIPPED'; note(`Skipped: live repo is on \`${branch}\`, not ${CFG.branch || 'main'}.`); return finish(state, false); }
  git(['fetch', '--quiet', 'origin']);
  const behind = Number(git(['rev-list', '--count', 'HEAD..origin/' + (CFG.branch || 'main')]).out || 0);
  if (behind > 0) {
    const ff = git(['merge', '--ff-only', 'origin/' + (CFG.branch || 'main')]);
    if (ff.code !== 0) { report.outcome = 'SKIPPED'; note(`Skipped: main cannot fast-forward to origin (${ff.out.split('\n').pop()}).`); return finish(state, false); }
  }
  const preSha = git(['rev-parse', 'HEAD']).out;

  // Fresh worktree from main.
  removeWorktree();
  git(['branch', '-D', WORK_BRANCH]);
  const add = git(['worktree', 'add', '-b', WORK_BRANCH, WT, preSha]);
  if (add.code !== 0) { report.outcome = 'FAILED'; note(`Worktree setup failed: ${add.out}`); return finish(state, false); }

  const c = await runClaude(prompt, model);
  report.claude = c;
  log(`claude ${c.status} after ${c.minutes} min, exit ${c.code}`);
  const dirtyWt = git(['status', '--porcelain'], WT).out;
  if (dirtyWt) note(`Uncommitted changes were left in the worktree and are NOT shipped:\n\n  \`\`\`\n${dirtyWt.split('\n').slice(0, 15).map((x) => '  ' + x).join('\n')}\n  \`\`\``);
  const commits = Number(git(['rev-list', '--count', `${preSha}..${WORK_BRANCH}`]).out || 0);
  if (commits === 0) {
    report.outcome = c.status === 'BLOCKED' ? 'BLOCKED' : c.status === 'TIMEOUT' ? 'FAILED' : 'NOOP';
    note('No commits - nothing to gate or deploy.');
    return finish(state, report.outcome === 'FAILED', item);
  }
  note(`${commits} commit(s) on ${WORK_BRANCH}.`);

  // Runner-side gates: Claude's own claim of green is not evidence.
  const gates = [...(CFG.gates || [])];
  if (CFG.deploy?.install && lockChanged(preSha, WORK_BRANCH)) gates.unshift(CFG.deploy.install);
  for (const g of gates) {
    const r = run(g, WT, CFG.gateTimeoutSec || 900);
    report.gates.push(r);
    if (r.code !== 0) break;
  }
  if (report.gates.some((g) => g.code !== 0)) {
    report.outcome = 'GATE-FAIL';
    parkBranch('red');
    return finish(state, true, item);
  }

  const branchOnly = item.tags.includes('branch') || NO_DEPLOY || CFG.deploy?.enabled === false;
  if (branchOnly) {
    report.outcome = 'PARKED';
    parkBranch('');
    return finish(state, false, item);
  }

  // Ship: fast-forward main. git refuses on its own if tonight's work overlaps a local edit.
  const ff = git(['merge', '--ff-only', WORK_BRANCH]);
  if (ff.code !== 0) {
    report.outcome = 'PARKED';
    note(`main could not fast-forward (${ff.out.split('\n').pop()}) - not deployed.`);
    parkBranch('');
    return finish(state, false, item);
  }

  const appState = CFG.pm2Process ? pm2Status(CFG.pm2Process) : 'online';
  if (appState !== 'online') {
    // The app is deliberately down (or missing): land the code, leave the box as Steven left it.
    note(`PM2 process \`${CFG.pm2Process}\` is ${appState} - code landed on main, the live app was not started.`);
    git(['push', 'origin', 'HEAD']);
    report.outcome = c.status === 'PARTIAL' ? 'PARTIAL' : 'LANDED';
    return finish(state, false, item, true);
  }

  // Baseline the slow smoke commands on the build that is live NOW, so a check that was already
  // red does not get tonight's work rolled back for it.
  let baselineRed = [];
  if (CFG.smoke?.cmdsBaseline && (CFG.smoke?.cmds || []).length) {
    git(['reset', '--keep', preSha]);
    for (const c of CFG.smoke.cmds) if (run(c, REPO, CFG.smoke?.cmdTimeoutSec || 900).code !== 0) baselineRed.push(c);
    git(['merge', '--ff-only', WORK_BRANCH]);
    if (baselineRed.length) note(`Baseline already red before deploy: ${baselineRed.map((c) => '`' + c + '`').join(', ')} - those checks cannot roll tonight back.`);
  }
  const bk = backupData();
  if (bk) note(`Live data backed up to \`${path.relative(REPO, bk)}\`.`);
  const headSha = git(['rev-parse', 'HEAD']).out;
  report.deploy = deploySteps(preSha, headSha);
  const deployOk = report.deploy.every((d) => d.code === 0);
  report.smoke = deployOk ? await smoke() : [];
  const counts = (s) => s.code !== 0 && !baselineRed.includes(s.cmd);
  const smokeOk = deployOk && !report.smoke.some(counts);

  if (!smokeOk) {
    note(deployOk ? 'Live smoke went red - rolling back.' : 'A deploy step failed - rolling back.');
    const back = git(['reset', '--keep', preSha]);
    if (back.code !== 0) note(`ROLLBACK FAILED (git reset --keep): ${back.out}. The live tree needs a person.`);
    const redeploy = deploySteps(headSha, preSha);
    const resmoke = redeploy.every((d) => d.code === 0) ? await smoke(baselineRed.length === 0) : [];
    const backOk = redeploy.every((d) => d.code === 0) && !resmoke.some(counts);
    report.deploy.push(...redeploy.map((r) => ({ ...r, cmd: `(rollback) ${r.cmd}` })));
    report.smoke.push(...resmoke.map((r) => ({ ...r, cmd: `(rollback) ${r.cmd}` })));
    note(backOk ? 'Rolled back: the previous build is live again and smoke-green.' : 'Rolled back, but the previous build is NOT smoke-green either - the live app needs a person.');
    parkBranch('rolled-back');
    report.outcome = backOk ? 'ROLLED-BACK' : 'BROKEN';
    return finish(state, true, item);
  }

  const push = git(['push', 'origin', 'HEAD']);
  if (push.code !== 0) note(`Deployed, but the push to origin failed: ${push.out.split('\n').pop()}`);
  report.outcome = c.status === 'PARTIAL' ? 'PARTIAL' : c.status === 'BLOCKED' ? 'BLOCKED' : 'SHIPPED';
  return finish(state, false, item, true);
}

function finish(state, failed, item, success) {
  if (item) {
    state.failures = state.failures || {};
    if (failed) state.failures[item.id] = (state.failures[item.id] || 0) + 1;
    else if (success) delete state.failures[item.id];
    if (failed && state.failures[item.id] >= (CFG.maxFailures || 2)) note(`${item.id} has now failed ${state.failures[item.id]} nights running - the night skips it until \`.nightly/state.json\` is cleared for it.`);
    if (item.tags.some((t) => t.startsWith('every:')) && !failed) (state.recurring = state.recurring || {})[item.id] = DATE;
  }
  if (!NOW) state.lastRun = DATE;
  writeState(state);
  if (item?.id && fs.existsSync(WT) && !failed) removeWorktree();

  const file = writeReport();
  const rel = path.relative(REPO, file).replace(/\\/g, '/');
  // The report is the runner's own file: commit just that path, then push.
  git(['add', '--', rel]);
  const cm = git(['commit', '-m', `nightly: report ${DATE} - ${report.outcome}${report.item ? ' ' + report.item.id : ''}`, '--', rel]);
  if (cm.code === 0) git(['push', 'origin', 'HEAD']);
  log(`report: ${rel} (${report.outcome})`);

  // Close the loop on the KG dashboard when the helper is on this box.
  if (CFG.kgLogTask && fs.existsSync(CFG.kgLogTask) && report.item) {
    spawnSync(process.execPath, [CFG.kgLogTask, '--agent', CFG.kgAgent, '--title', `${CFG.app} night: ${report.item.id} ${report.outcome}`, '--output', `${report.item.title} - see nightly/reports/${DATE}.md`], { windowsHide: true, timeout: 30000 });
  }
}

main().catch((e) => {
  try { log(`runner crashed: ${e.stack || e}`); fs.rmSync(LOCK, { force: true }); } catch { /* best effort */ }
  process.exit(1);
});

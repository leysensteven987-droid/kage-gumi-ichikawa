# Ichikawa 市川 — Market Scout

A personal, single-user app that turns a **recipe library into a weekly shopping list**,
then plots the pickup route through the **Jumbo Gent** store. The UI is a soft, fluffy
**kawaii-bento** surface: a recipe grid (RECEPTEN), a weekly bento tray (WEEKPLAN), a
generated boodschappenlijst, and an in-store route map.

Recipes come from a personal **HelloFresh corpus** (scraped by the engine below); a
committed seed (`data/recipes.sample.json`) keeps the app rendering on a fresh checkout
with no personal data.

## Lineage

Forked out of the **kage-gumi** monorepo, where Ichikawa was one of the personal
"operatives." It keeps the family lineage: the repo is named `kage-gumi-ichikawa`, the
UI keeps its `kg-` CSS class prefixes and `data-kg-*` attributes, and the kawaii-bento
look is unchanged. It now stands alone — its own Express server, Vite shell, and PWA,
with no KG dashboard around it.

## Develop

```bash
npm install
```

Two ways to run:

- **Split (hot-reload UI):** `npm run start` (Express API on 5273) in one terminal, then
  `npm run dev` (Vite UI on 5173, proxying `/api` → 5273) in another.
- **One port (built app):** `npm run build`, then `npm run start` — the Express server
  serves the built UI **and** the API together on `http://localhost:5273`.

## Recipe engine (HelloFresh)

The `engine/` scripts build the personal corpus. HelloFresh Belgium sits behind Datadome,
so capture is a manual, headed step:

```bash
npm run capture   # headed browser — log in to HelloFresh by hand, saves data/.hf-session.json
npm run pull      # discover past-box recipe detail URLs -> data/box-history-urls.txt
npm run enrich    # normalize recipe pages -> data/recipes/<id>.json   (pass URLs or --file)
npm run clean     # one-off: re-clean titles/steps across the corpus in place
```

Its data lives under `data/` and is **gitignored**: `data/recipes/` (the corpus),
`data/.hf-session.json` (saved login), `data/.hf-creds.json` (optional), the browser
profile, and `data/box-history-urls.txt`. Only the seed and the store map are committed.

## Box deploy

Runs under PM2 via `ecosystem.config.cjs` (one app on port 5273):

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs
```

Expose it with a Cloudflare Tunnel ingress: `ichikawa.kage-gumi.com → localhost:5273`.

### Auto-deploy

A bare `git pull` is **not** a deploy: the server serves the pre-built `dist/`, so
without a rebuild + PM2 reload new commits never reach the running app.
`scripts/autodeploy.sh` closes that gap — it fetches the deploy branch and, only
when new commits arrived, runs `npm ci` (when deps changed), `npm run build`, and
`pm2 reload`. It is a cheap no-op when nothing changed and guards against
overlapping runs, so it is safe on a tight schedule.

Point the box's cron at it instead of a plain pull (the `bash -lc` loads the login
profile so `node`/`npm`/`pm2` are on `PATH`):

```cron
*/10 * * * * bash -lc '/opt/kage-gumi-ichikawa/scripts/autodeploy.sh >> /var/log/ichikawa-deploy.log 2>&1'
```

Deploy branch and PM2 app name are overridable via `ICHIKAWA_DEPLOY_BRANCH`
(default `main`) and `ICHIKAWA_PM2_APP` (default `kage-gumi-ichikawa`). One-time
setup on the box: run `scripts/autodeploy.sh` once by hand (or the manual build
above) to land the first build, then swap the cron line in.

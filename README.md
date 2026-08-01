# Ichikawa 市川 — Market Scout

A personal, single-user app that turns a **recipe library into a weekly shopping list**,
then plots the pickup route through the **Jumbo Gent** store. The UI is a soft, fluffy
**kawaii-bento** surface: a recipe grid (RECIPES), a weekly bento tray (PLAN), a
generated shopping list, and an in-store route map.

Recipes come from a personal **HelloFresh corpus** (scraped by the engine below); a
committed seed (`data/recipes.sample.json`) keeps the app rendering on a fresh checkout
with no personal data.

## Language

The **interface is English** — every label, button, filter, empty state, aisle name and
error message. **Recipe content is not**: titles, subtitles, cuisine, tags, ingredient
names, step text and parallel tips render verbatim from the corpus and stay in whatever
language the recipe was written in (mostly Dutch, from HelloFresh BE).

Two consequences worth knowing before editing:

- The store lexicon in `data/jumbo-gent-store.json` splits the same way — zone `label`s
  are English, but every `keywords` entry (and every zone `id`) stays Dutch, because the
  keywords have to match Dutch ingredient names. Translating a keyword breaks routing.
- `CUISINE` in `IchikawaSurface.jsx` is keyed on the corpus' own cuisine values
  (`"Italiaans"`, `"Vis"`, …). Those are lookup keys, not copy — only the emoji is shown.

## Lineage

Forked out of the **kage-gumi** monorepo, where Ichikawa was one of the personal
"operatives." It keeps the family lineage: the repo is named `kage-gumi-ichikawa`, the
UI keeps its `kg-` CSS class prefixes and `data-kg-*` attributes, and the kawaii-bento
look is unchanged. It now stands alone — its own Express server, Vite shell, and PWA,
with no KG dashboard around it.

## Layout

One repo, two clients of the same Express server:

```
server/  engine/  src/  public/   the web app — Express API + Vite/React PWA
android/                          the native Android client
data/                             the corpus (gitignored) + committed seed
```

Both talk to the API documented below; `android/` never reads `data/` directly. The
box deploy only ever builds and serves the web app — `scripts/autodeploy.ps1` skips its
rebuild entirely when a push touched only `android/`, so Android work never bounces the
running web app.

## Develop

```bash
npm install
cp .env.example .env   # optional — see below
```

Both env vars are **optional**. With `LOCK_PASSPHRASE` unset the passphrase gate is a
no-op pass-through, which is the normal local-dev setup: no unlock page, straight into
the app. Only the exposed box needs them filled in. A fresh checkout also needs no data
step — with `data/recipes/` empty the loader falls back to the committed seed and the
app renders (the API reports `source: "seed"` instead of `"corpus"`).

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

The same normalizer is exposed in-app: **RECIPES → ＋ Add a recipe** (phone and
desk) posts a link to `POST /api/recipes/add`, which pulls the page's schema.org
recipe into `data/recipes/<id>.json` and drops the dish straight into the library —
no command line needed for a one-off add.

Its data lives under `data/` and is **gitignored**: `data/recipes/` (the corpus),
`data/.hf-session.json` (saved login), `data/.hf-creds.json` (optional), the browser
profile, and `data/box-history-urls.txt`. Only the seed and the store map are committed.

## API

The Express server in `server/index.js` is the whole contract — the React shell is just
one client of it, and a second client (a native Android app, a script) needs nothing the
web UI doesn't already use. All payloads are JSON.

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/api/recipes` | → `{ recipes, source, count }`; `source` is `corpus`, `seed` or `empty` |
| `POST` | `/api/recipes/add` | `{ url }` — fetches + normalizes a schema.org recipe page. Slow (up to 55 s), `422` when the page has no recipe markup, `504` on timeout |
| `POST` | `/api/recipes/:id/remove` | soft-remove — sets `keep:false`, never deletes |
| `PUT` | `/api/recipes/:id` | partial patch of the editable fields; absent fields are left alone |
| `PUT` | `/api/recipes/:id/ingredients` | `{ ingredients: [{name, qty, unit}] }`, max 100 rows |
| `POST` | `/api/recipes/photo` | `{ dataUrl, note? }` — base64 JPG/PNG/WEBP/HEIC, max 15 MB. Stores only; no AI call happens here |
| `GET` | `/api/recipes/photo-inbox` | → `{ items }`, pending photos, newest first |
| `GET` | `/api/recipes/photo/:id/image` | raw image bytes |
| `DELETE` | `/api/recipes/photo/:id` | hard delete — image + sidecar |

Two behaviours worth knowing before writing a second client:

- **Copy-on-write.** While the corpus is empty the app serves the committed seed. The
  first write to a seed-only recipe materializes the *entire* served set into
  `data/recipes/` — because the loader flips to corpus-only the moment any file exists.
  So one edit from the Android app converts the whole library from seed to corpus. That
  is intended, not a bug, but it means "edit one recipe" is a bigger write than it looks.
- **Ids are path-checked.** Every `:id` route rejects `/`, `\` and `..` with a `400`.

### Auth for a non-browser client

`server/lock.mjs` fronts everything. When `LOCK_PASSPHRASE` is unset the gate is a
pass-through and no auth is needed at all — which is the simplest way to develop against
a local server. Against the tunnelled host, the flow is a cookie:

```
POST /__unlock   {"passphrase": "..."}   →  302 + Set-Cookie: ichikawa_lock=<token>
```

Send that cookie on every subsequent request. It is an `HttpOnly`, `SameSite=Lax`,
~30-day HMAC token — an Android client needs a cookie jar (OkHttp `CookieJar`, or read
the `Set-Cookie` header and store the value yourself). Notes:

- `/api/*` **always** answers JSON, including `401 {"error":"locked"}` when locked out —
  a non-browser client never has to parse the HTML lock page.
- A `GET` for a non-`/api` path answers the lock page as **`200` HTML**, not a `401`.
  Don't treat "got a 200" as "authenticated" when probing.
- `/icon.svg`, `/apple-touch-icon.png`, `/manifest.webmanifest`, `/favicon.ico` and
  `/sw.js` pass the gate unauthenticated by design.

## Box deploy

Runs under PM2 via `ecosystem.config.cjs` (one app on port 5273):

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs
```

Expose it with a Cloudflare Tunnel ingress: `ichikawa.kage-gumi.com → localhost:5273`.

### Auto-deploy (Windows box)

A bare `git pull` is **not** a deploy: the server serves the pre-built `dist/`, so
without a rebuild + PM2 reload new commits never reach the running app. The box is
a Windows / PowerShell host, so `scripts/autodeploy.ps1` closes that gap — it
fetches the deploy branch and, only when new commits arrived, runs `npm ci` (when
deps changed), `npm run build`, and `pm2 reload`. It is a cheap no-op when nothing
changed and guards against overlapping runs, so it is safe on a tight schedule.

Register it with Task Scheduler to run every 10 minutes (adjust the clone path):

```powershell
schtasks /Create /TN "ichikawa-autodeploy" /SC MINUTE /MO 10 /F `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\kage-gumi-ichikawa\scripts\autodeploy.ps1"
```

Deploy branch and PM2 app name are overridable via `ICHIKAWA_DEPLOY_BRANCH`
(default `main`) and `ICHIKAWA_PM2_APP` (default `kage-gumi-ichikawa`).

One-time bootstrap on the box (PowerShell — note `&&` is **not** a valid separator
in Windows PowerShell 5.x, so run the steps on separate lines):

```powershell
git pull
npm ci
npm run build
pm2 reload kage-gumi-ichikawa
```

That lands the first build; then register the scheduled task above.

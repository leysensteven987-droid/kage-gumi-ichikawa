# Ichikawa 市川 — night plan

The night shift (`nightly/run.mjs`, PM2 `kage-gumi-ichikawa-nightly`, 01:00 on Steven's personal
Claude seat) takes **one item per night** from this file, works it in a throwaway worktree, gates
it, deploys it live and smoke-tests it. Rules for every night: `nightly/BRIEF.md`.

**How the night picks:** a recurring item due today → a `[~]` partial → the first open item of
tonight's lane (lanes alternate: `REL` one night, `TUNE` the next) → any open item.
**Legend:** `[ ]` open · `[~]` partial · `[x]` done · `[!]` blocked on Steven ·
tags `[opus]` harder work, Opus model · `[branch]` parked on a review branch, never deployed ·
`[next]` taken before the lane rotation · `[hold]` never taken unattended (a decision or access only Steven can give) · `[every:<day>]` recurring.
**Steven:** reorder freely, tag `[hold]` to stop an item, drop `.nightly/PAUSED` in the repo to stop the shift.

## Release target — what "public" means here

Per-app accounts (Steven, 12NOV26): Ichikawa gets its **own** sign-up, sign-in and admin; no shared
login with the sibling apps. Release-ready when all of these hold:

- Every recipe, plan, pantry and shopping list belongs to one user; nobody can read another's.
- A brand-new user lands in a working, empty app (no Steven data, no HelloFresh corpus).
- Invite-only sign-up, admin can disable / delete users and reset a password by link (no email
  provider needed for v1).
- Abuse limits on every write and every Claude-backed call; Claude cost capped per user per day.
- Export my data / delete my account work.
- Privacy page and terms exist; content licensing settled (see REL-14).

---

## Recurring

- [ ] **R-UPD** Weekly dependency refresh: `npm outdated`, apply patch + minor updates, rebuild, run tests; majors become `[hold]` Inbox items with the changelog risk in one line. `[every:sun]`
- [ ] **R-AUDIT** Weekly security pass over the last 7 days of commits: auth, per-user scoping, input validation, path handling, SSRF, secrets in code; `npm audit --omit=dev`. Fix what is small, file the rest in the Inbox. `[every:wed]`

## REL — public release lane

- [ ] **REL-01** Test harness and a public health probe. `[next]`
  - Add `npm test` (`node --test`, no new framework) with a helper that boots the Express app on an ephemeral port against a temp data dir.
  - First tests: recipes list/add/remove, pantry and shopping round-trips, lock gate (locked → 401 JSON, unlocked → 200).
  - Add `GET /api/health` → `{ ok, service, version }` that answers BEFORE the lock (no data in it); add it to the night smoke later.
  - Done when `npm test` is green and covers every route at least once.
- [ ] **REL-02** One data store module. Move every read/write of `data/recipes`, `pantry.json`, `shopping.json`, `photo-inbox` behind `server/store.mjs` taking a `userId` (today always `"owner"`). No layout change on disk yet. Tests prove behaviour is unchanged.
- [ ] **REL-03** Input hardening on every route: body size per route, JSON shape validation, id format checks (no path traversal through `:id`), image type sniffing on photo upload (magic bytes, not the header), a per-IP rate limit on writes and on `/api/recipes/add` + photo-to-recipe. Tests for each refusal.
- [ ] **REL-04** SSRF guard on `POST /api/recipes/add`: the server fetches a user-given URL — refuse private, loopback, link-local and `.local`/tailnet hosts after DNS resolution, cap redirects and response size, timeout. Tests with a stub resolver. `[opus]`
- [ ] **REL-05** Accounts design note `docs/accounts.md`: `node:sqlite` (built into Node 24, verified on the box) for users + sessions, scrypt password hashes, HMAC session cookie reusing `server/lock.mjs`'s signing, roles `owner|admin|user`, invite codes, admin reset links, per-user data layout `data/users/<id>/…`, migration of today's owner data. Plan only, no code. `[opus]`
- [ ] **REL-06** Accounts, part 1 — behind `AUTH_MODE` (`passphrase` default, `accounts` opt-in): users table, sign-in / sign-out, session cookie, `req.user`, owner bootstrap from env on first boot. Passphrase mode must be byte-for-byte today's behaviour. Tests for both modes. `[opus]`
- [ ] **REL-07** Accounts, part 2 — invite-only sign-up (admin makes single-use codes), password change, admin reset link, login brute-force lockout (per account + per IP). Tests. `[opus]`
- [ ] **REL-08** Per-user data, behind `AUTH_MODE=accounts` only: store resolves `data/users/<id>/`; the owner's existing files are copied (never moved) into the owner's folder on first boot, idempotent. Tests prove user A cannot read, change or delete user B's recipes / pantry / list / photos (IDOR tests per route). `[opus]`
- [ ] **REL-09** Admin view `/admin` (owner/admin only): users list, invite codes, disable, delete-with-data, reset link, per-user storage and Claude usage. UI in the kawaii-bento style.
- [ ] **REL-10** Claude cost control: photo-to-recipe and the timing pass run through one wrapper with a per-user daily cap, a global daily cap, a kill switch env, and usage logged per user. Friendly over-limit message.
- [ ] **REL-11** Security headers: CSP (self + the image hosts actually used), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`; CSRF on mutating routes (SameSite=Lax cookie + Origin check). Tests.
- [ ] **REL-12** My data: `GET /api/me/export` (zip or JSON of everything the user owns) and delete-my-account (with confirm), both tested.
- [ ] **REL-13** New-user experience: empty-state screens for recipes / plan / list with one clear next step (add a recipe by link or photo); no Steven or HelloFresh content shown to anyone but the owner; the committed sample seed is clearly demo data.
- [ ] **REL-14** Content and licensing decision: HelloFresh recipes are copyrighted and scraped behind Datadome — they can stay the owner's private corpus but cannot ship to other users; the store map is Jumbo Gent only. Decide: public users import their own recipes only? store map per user / per store? `[hold]`
- [ ] **REL-15** Privacy page + terms + cookie note (functional cookie only), linked from the sign-in screen. Draft text, owner reviews. `[branch]`
- [ ] **REL-16** Ops: structured request log (no bodies, no personal data), error log with request id, log rotation, a restore runbook for `.nightly/backups` and the per-user data. `README` deploy section updated.
- [ ] **REL-17** Hosting and domain for the public build: stay on the box behind the tunnel or move; uptime expectations; backup offsite. `[hold]`

## TUNE — fine-tuning lane

- [ ] **TUNE-01** Shopping list maths: merge the same ingredient across planned recipes (unit normalisation g/kg, ml/l, stuks, el/tl), sum quantities, keep the original lines on tap. Tests with real-shaped recipe fixtures (no personal data).
- [ ] **TUNE-02** Pantry exclusion: staples marked in the pantry drop off the list (or show as "have it"), with a one-tap "need it anyway".
- [ ] **TUNE-03** Recipe library at scale: the corpus is ~1.6 MB and loads whole — paginate or slim the list payload (cards only), lazy-load the detail. Measure before/after payload and first paint; note numbers in the report.
- [ ] **TUNE-04** Search and filters: title + ingredient search (accent-insensitive, Dutch), filters for cuisine, time, already-planned; keyboard and screen-reader friendly.
- [ ] **TUNE-05** Store route accuracy: unmatched ingredients surface as "where is this?" with a one-tap zone pick that is remembered (per user later); report the unmatched rate on the current corpus before/after.
- [ ] **TUNE-06** Offline in store: the shopping list and route work with no signal (service worker caches the list API response; ticks queue and sync back).
- [ ] **TUNE-07** Photo-to-recipe quality: retry once on malformed model output, schema-validate the result, show what was guessed so the user can fix it; test with a stubbed model.
- [ ] **TUNE-08** Accessibility pass: contrast on the pastel palette, focus rings, tap targets ≥ 44 px, labels on icon buttons. Fix the top findings, list the rest.
- [ ] **TUNE-09** Performance budget: bundle size report on build, flag anything > 250 KB gzipped, split the heaviest route.

## Inbox


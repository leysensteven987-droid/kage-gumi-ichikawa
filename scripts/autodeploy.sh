#!/usr/bin/env bash
#
# Ichikawa box auto-deploy.
#
# Meant to run from cron on the kage-gumi box, in place of a bare `git pull`.
# It fetches the deploy branch and, ONLY when new commits actually arrived,
# rebuilds the UI (dist/) and reloads the PM2 app. When nothing changed it is a
# cheap no-op, so a tight schedule (every ~10 min) is fine.
#
#   Why a script and not just `git pull`: pulling refreshes the source, but the
#   server serves the PRE-BUILT dist/. Without `npm run build` + a PM2 reload,
#   new features never reach the running app. This closes that gap.
#
# Cron wiring (load the login profile so node/npm/pm2 are on PATH):
#   */10 * * * * bash -lc '/opt/kage-gumi-ichikawa/scripts/autodeploy.sh >> /var/log/ichikawa-deploy.log 2>&1'
#
# Overrides via env: ICHIKAWA_DEPLOY_BRANCH (default main),
#                    ICHIKAWA_PM2_APP       (default kage-gumi-ichikawa).
#
# Safe by design: an overlapping run is skipped (flock), and only tracked files
# are reset — the gitignored personal corpus under data/recipes/ is untouched.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${ICHIKAWA_DEPLOY_BRANCH:-main}"
PM2_APP="${ICHIKAWA_PM2_APP:-kage-gumi-ichikawa}"
LOCK="/tmp/ichikawa-autodeploy.lock"

log() { echo "[autodeploy $(date -u +%FT%TZ)] $*"; }

# Prevent overlapping runs — a slow build must not collide with the next tick.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another deploy is in progress; skipping this tick"
  exit 0
fi

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "already at ${LOCAL:0:9}; nothing to deploy"
  exit 0
fi

log "new commits ${LOCAL:0:9} -> ${REMOTE:0:9}; deploying ${BRANCH}"
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/${BRANCH}"

# Reinstall dependencies only when the manifest/lockfile moved (fast path else).
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package.json package-lock.json; then
  log "dependencies changed; running npm ci"
  npm ci
fi

log "building UI (npm run build)"
npm run build

# Static assets are served straight from disk, so the rebuilt dist/ is live
# immediately; the reload additionally picks up any server/ changes. Fall back
# to a fresh start if the app is not registered with PM2 yet.
log "reloading PM2 app '${PM2_APP}'"
pm2 reload "$PM2_APP" --update-env || pm2 start ecosystem.config.cjs

log "deployed ${REMOTE:0:9}"

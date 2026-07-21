#requires -Version 5
<#
    Ichikawa box auto-deploy (Windows / PowerShell).

    Meant to run from Task Scheduler on the kage-gumi box in place of a bare
    `git pull`. It fetches the deploy branch and, ONLY when new commits actually
    arrived, rebuilds the UI (dist/) and reloads the PM2 app. When nothing
    changed it is a cheap no-op, so a tight schedule (every ~10 min) is fine.

      Why a script and not just `git pull`: pulling refreshes the source, but the
      server serves the PRE-BUILT dist/. Without `npm run build` + a PM2 reload,
      new features never reach the running app. This closes that gap.

    Register once (every 10 min), adjusting the path to the clone:
      schtasks /Create /TN "ichikawa-autodeploy" /SC MINUTE /MO 10 /F `
        /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\kage-gumi-ichikawa\scripts\autodeploy.ps1"

    Overrides via env: ICHIKAWA_DEPLOY_BRANCH (default main),
                       ICHIKAWA_PM2_APP       (default kage-gumi-ichikawa).

    Safe by design: an overlapping run is skipped (exclusive lock file), and only
    tracked files are reset — the gitignored personal corpus under data/recipes/
    is untouched.
#>
$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoDir

$Branch = if ($env:ICHIKAWA_DEPLOY_BRANCH) { $env:ICHIKAWA_DEPLOY_BRANCH } else { "main" }
$Pm2App = if ($env:ICHIKAWA_PM2_APP) { $env:ICHIKAWA_PM2_APP } else { "kage-gumi-ichikawa" }
$LockPath = Join-Path $env:TEMP "ichikawa-autodeploy.lock"

function Log($msg) {
    Write-Host ("[autodeploy {0}Z] {1}" -f (Get-Date).ToUniversalTime().ToString("s"), $msg)
}

# Overlap guard — hold an exclusive lock file for the whole run. If another tick
# is mid-deploy the open fails and we skip rather than collide with its build.
try {
    $lock = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    Log "another deploy is in progress; skipping this tick"
    return
}

try {
    git fetch --quiet origin $Branch
    $local  = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse "origin/$Branch").Trim()

    if ($local -eq $remote) {
        Log "already at $($local.Substring(0,9)); nothing to deploy"
        return
    }

    Log "new commits $($local.Substring(0,9)) -> $($remote.Substring(0,9)); deploying $Branch"
    git checkout --quiet $Branch
    git reset --hard --quiet "origin/$Branch"

    # Reinstall dependencies only when the manifest/lockfile moved (fast path else).
    git diff --quiet $local $remote -- package.json package-lock.json
    if ($LASTEXITCODE -ne 0) {
        Log "dependencies changed; running npm ci"
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }

    Log "building UI (npm run build)"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

    # Static assets are served straight from disk, so the rebuilt dist/ is live
    # immediately; the reload additionally picks up any server/ changes. Fall
    # back to a fresh start if the app is not registered with PM2 yet.
    Log "reloading PM2 app '$Pm2App'"
    pm2 reload $Pm2App --update-env
    if ($LASTEXITCODE -ne 0) { pm2 start ecosystem.config.cjs }

    Log "deployed $($remote.Substring(0,9))"
}
finally {
    $lock.Close()
    Remove-Item -LiteralPath $LockPath -ErrorAction SilentlyContinue
}

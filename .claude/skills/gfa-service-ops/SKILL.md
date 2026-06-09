---
name: gfa-service-ops
description: Operate GFA production updates, restarts, health checks, Caddy reverse proxy checks, and BingchaAI Wails client release publishing. Use for Windows server flows with pnpm start:stop/start:daemon, git pull deployment, GitHub artifact/release downloads from private repositories using gh CLI first and GitHub API + curl fallback, cutting a Wails client release via the build-wails.yml GitHub Actions workflow (gh workflow run, version input), bumping apps/bcai-wails/updater.go AppVersion or the server minClientVersion floor in apps/api lease-service.ts, or editing latest-wails.json.
---

# GFA Service Ops

## Rules

- Assume Windows PowerShell on customer servers.
- Default repo path: `C:\Users\Administrator\Desktop\GFA`.
- Do not touch Caddy during normal code updates.
- Do not delete `.env`, `prisma/dev.db`, backups, logs, or `apps\web\public\updates\*` unless explicitly requested.
- Check the deployed branch before pulling. This repo currently uses `main`; old servers may use `master`.
- For GitHub operations, prefer `gh` CLI. If `gh` is not in PATH, search common install paths before falling back to GitHub API + `curl.exe`.

## Paths

- Service scripts: root `package.json` -> `start:stop`, `start:daemon`, implemented by `scripts/start.mjs`.
- PID: `gfa.pid`.
- Logs: `logs\daemon.log`, `logs\api-YYYY-MM-DD.log`, `logs\web-YYYY-MM-DD.log`, `logs\worker-YYYY-MM-DD.log`.
- Ports: Web `3000`, API `3001` unless `.env` overrides `WEB_PORT` / `API_PORT`.
- Client version: `apps\bcai-wails\updater.go` -> `AppVersion`.
- Client update manifest: `apps\web\public\updates\latest-wails.json`.
- Public update files: `apps\web\public\updates\`.

## Service Update

Normal code update:

```powershell
cd C:\Users\Administrator\Desktop\GFA
pnpm start:stop
git branch --show-current
git pull origin main
pnpm start:daemon
```

Use `git pull origin master` only if `git branch --show-current` prints `master`.

`pnpm start:stop` sends `SIGTERM` to the PID in `gfa.pid`. `pnpm start:daemon` rebuilds, clears stale Web/API port owners, starts API/Worker/Web, then polls `http://127.0.0.1:3001/api/health`.

Schema-sensitive update (Prisma Migrate):

The DB now uses **Prisma Migrate** — versioned migrations under `prisma\migrations\` applied in order (not the old `db push` / diff-apply). After pulling code that changed the Prisma schema:

```powershell
cd C:\Users\Administrator\Desktop\GFA
pnpm start:stop
git pull origin main
New-Item -ItemType Directory -Force backups | Out-Null
Copy-Item prisma\dev.db "backups\dev-$(Get-Date -Format yyyyMMdd-HHmmss).db"   # always back up first
pnpm db:migrate            # = prisma migrate deploy (applies pending migrations in order; non-destructive)
pnpm start:daemon
```

⚠ **One-time baseline before `migrate deploy` works on an existing server.** The production DB was previously managed by `db push`, so its tables exist outside Prisma's migration history. Run the one-time baseline documented in `prisma\MIGRATIONS.md` once (back up → sync schema → clear `_prisma_migrations` metadata → `prisma migrate resolve --applied 0_init`). **Until that baseline is done**, use the legacy diff-apply instead — it also backs up `prisma\dev.db` into `backups\`:

```powershell
cd C:\Users\Administrator\Desktop\GFA
git pull origin main
powershell -ExecutionPolicy Bypass -File scripts\deploy-update.ps1
```

Restart only:

```powershell
cd C:\Users\Administrator\Desktop\GFA
pnpm start:stop
pnpm start:daemon
```

## Checks

```powershell
netstat -ano | findstr ":3000 :3001"
curl.exe http://127.0.0.1:3001/api/health
Get-Content .\logs\daemon.log -Tail 80
Get-Content .\logs\api-$(Get-Date -Format yyyy-MM-dd).log -Tail 80
Get-Content .\logs\web-$(Get-Date -Format yyyy-MM-dd).log -Tail 80
Get-Content .\logs\worker-$(Get-Date -Format yyyy-MM-dd).log -Tail 80
```

If a stale process still owns a GFA port:

```powershell
netstat -ano | findstr ":3000"
taskkill /F /PID <pid>
netstat -ano | findstr ":3001"
taskkill /F /PID <pid>
```

## Caddy

Do not restart/reload Caddy for normal GFA updates. Only inspect or operate Caddy when domain/proxy access is broken, Caddy is not running, ports 80/443 are involved, or `Caddyfile` changed.

```powershell
netstat -ano | findstr ":80 :443"
cd C:\Users\Administrator\Desktop\caddy
.\caddy.exe start
.\caddy.exe start --config Caddyfile
.\caddy.exe reload
```

Use `start` only when Caddy is not running. Use `reload` only after `Caddyfile` changes.

## Client Update Publishing (Wails / BingchaAI)

**Canonical path = trigger the GitHub Actions workflow.** It builds all platforms, publishes the
GitHub Release, and auto-regenerates + commits the manifest. Do NOT hand-build / hand-edit the
manifest unless the workflow is unavailable.

Steps:

1. Bump source-of-truth `AppVersion` in `apps\bcai-wails\updater.go` to the release version
   (the build also injects it via `-ldflags -X main.AppVersion=<version>`, but keep the source honest).
2. (If the new version should be mandatory) raise the server minimum — see "Server minimum client version".
3. Commit + push to `main`, then dispatch the build:

```bash
gh workflow run build-wails.yml --ref main -f version=8.6.0 -f changelog="桌面端体验优化与稳定性修复"
gh run list --workflow build-wails.yml --limit 1      # grab run id
gh run watch <run-id>
```

`.github/workflows/build-wails.yml` then:

- Builds windows/amd64, macOS arm64 + amd64, linux/amd64 with `AppVersion=<version>`.
- Publishes Release `wails-v<version>` (release name 「冰茶AI v<version>」) to the **public** repo
  `bingcha-2/bcai-releases` (auth = secret `BCAIDOWNLOAD`); clients download binaries straight from GitHub CDN.
  Verify with `gh release view wails-v<version> --repo bingcha-2/bcai-releases`.
- Auto-generates `apps\web\public\updates\latest-wails.json` (both `version` and `minVersion` = the
  input version) and **git-pushes it to `main`** → run `git pull` afterwards.

⚠ `changelog` is PUBLIC (release notes + in-app update prompt). Keep it neutral; never describe
internal mechanics.

⚠ `minVersion = version` is a non-skippable forced upgrade: clients below it are pushed to update,
and the server also rejects them at lease time (see below). Use the exact version you intend as the floor.

Binaries are NO LONGER committed to `apps\web\public\updates\` — only `latest-wails.json` lives there.
The Wails build output `apps\bcai-wails\build\bin\` is not the public update dir.

### Server minimum client version

`apps\api\src\lease-core\lease-service.ts` → `minClientVersion` default (currently `9.1.0`) is the
single floor for ALL lease paths — `RemoteAnthropicService` / `RemoteCodexService` / `TokenServerService`
all extend `LeaseService` and none override it (their modules call
`new XxxService({ tokenUsageTracker, accountQuotaSnapshotTracker })` with no `minClientVersion`).
Clients below the floor get 426 "upgrade required" at lease time. Bump it
alongside a release you want mandatory. `lease-core/__tests__/lease-service.spec.ts` pins this floor —
update its accept/reject versions to match. (Tests run via `vitest`, not jest.)

### Fallback: manual single-platform build (only when the workflow is down)

```powershell
cd C:\Users\Administrator\Desktop\GFA\apps\bcai-wails
wails build -platform windows/amd64 -clean -ldflags "-s -w -X main.AppVersion=8.6.0"
# then upload the .exe to a bingcha-2/bcai-releases Release (tag wails-v8.6.0)
# and hand-edit apps\web\public\updates\latest-wails.json (url/sha256/size/version/minVersion).
```

## GitHub CLI

For GitHub operations, first resolve `gh`:

```powershell
$gh = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  $gh = @(
    "$env:ProgramFiles\GitHub CLI\gh.exe",
    "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe",
    "$env:LOCALAPPDATA\GitHub CLI\gh.exe",
    "$env:USERPROFILE\scoop\apps\gh\current\bin\gh.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $gh) { throw "gh CLI not found; use the curl fallback below." }
& $gh auth status
```

Private GitHub Actions artifact download with `gh`:

```powershell
cd C:\Users\Administrator\Desktop\GFA
$repo = "<github-owner>/<private-repo>"
$artifactName = "BingchaAI"
$outDir = ".\apps\web\public\updates"
New-Item -ItemType Directory -Force $outDir | Out-Null

$runId = (& $gh run list --repo $repo --workflow build-wails.yml --branch main --json databaseId,status,conclusion,createdAt --limit 20 |
  ConvertFrom-Json | Where-Object { $_.conclusion -eq "success" } | Select-Object -First 1).databaseId
if (-not $runId) { throw "No successful build-wails.yml run found." }

& $gh run download $runId --repo $repo --name $artifactName --dir $outDir
Get-ChildItem $outDir -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 20
```

If the artifact name is platform-specific, list available artifact names:

```powershell
& $gh run view $runId --repo $repo --json artifacts
```

Private GitHub Release asset download with `gh`:

```powershell
cd C:\Users\Administrator\Desktop\GFA
$repo = "<github-owner>/<private-repo>"
$assetName = "BingchaAI-5.1.6.exe"
$outDir = ".\apps\web\public\updates"
New-Item -ItemType Directory -Force $outDir | Out-Null
& $gh release download --repo $repo --pattern $assetName --dir $outDir --clobber
Get-FileHash "$outDir\$assetName" -Algorithm SHA256
(Get-Item "$outDir\$assetName").Length
```

If `gh` cannot be installed or authenticated, use GitHub API + `curl.exe` and `$env:GITHUB_TOKEN`:

```powershell
cd C:\Users\Administrator\Desktop\GFA
$owner = "<github-owner>"
$repo = "<private-repo>"
$artifactName = "BingchaAI"
$outDir = ".\apps\web\public\updates"
$zipPath = "$outDir\github-artifact-latest.zip"
New-Item -ItemType Directory -Force $outDir | Out-Null

$json = curl.exe -sS -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$owner/$repo/actions/artifacts?per_page=100"
$artifact = ($json | ConvertFrom-Json).artifacts | Where-Object { -not $_.expired -and $_.name -like "*$artifactName*" } | Sort-Object created_at -Descending | Select-Object -First 1
if (-not $artifact) { throw "No matching non-expired artifact found." }

curl.exe -L -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -o $zipPath "https://api.github.com/repos/$owner/$repo/actions/artifacts/$($artifact.id)/zip"
Expand-Archive -Path $zipPath -DestinationPath $outDir -Force
Remove-Item $zipPath -Force
Get-ChildItem $outDir | Sort-Object LastWriteTime -Descending | Select-Object -First 20
```

If the zip extracts into a nested folder, move the final `BingchaAI-*` files up to `apps\web\public\updates\`.

Private GitHub Release asset download:

```powershell
cd C:\Users\Administrator\Desktop\GFA
$owner = "<github-owner>"
$repo = "<private-repo>"
$assetName = "BingchaAI-5.1.6.exe"
$outFile = ".\apps\web\public\updates\$assetName"

$release = curl.exe -sS -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$owner/$repo/releases/latest"
$asset = ($release | ConvertFrom-Json).assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) { throw "Release asset not found: $assetName" }

curl.exe -L -H "Authorization: Bearer $env:GITHUB_TOKEN" -H "Accept: application/octet-stream" -o $outFile "https://api.github.com/repos/$owner/$repo/releases/assets/$($asset.id)"
Get-FileHash $outFile -Algorithm SHA256
(Get-Item $outFile).Length
```

Manifest is auto-generated by the workflow; only hand-edit (`version`, `url`/`sha256`/`size`, `changelog`, `minVersion`, and `macOS` / `linux` platform assets) in the manual fallback. The client checks `https://bcai.lol/updates/latest-wails.json` by default (primary domain; auto-falls back to `bcai.space` — see `bcai_hosts.go`); `BCAI_UPDATE_URL` overrides it for local testing.

Linux caveat: current Linux in-app updater replaces the binary directly from `bcai-update-<version>.tmp`; a `.tar.gz` URL is fine for manual download but does not match auto-update unless extraction support is added.

## Final Verification

- `pnpm start:daemon` reports services ready.
- `curl.exe http://127.0.0.1:3001/api/health` succeeds.
- `netstat -ano | findstr ":3000 :3001"` shows expected listeners.
- For client updates, `/updates/latest-wails.json` is reachable and referenced asset URLs download.

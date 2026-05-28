---
name: gfa-service-ops
description: Operate GFA production updates, restarts, health checks, Caddy reverse proxy checks, and BingchaAI Wails client release publishing. Use for Windows server flows with pnpm start:stop/start:daemon, git pull deployment, GitHub artifact/release downloads from private repositories using gh CLI first and GitHub API + curl fallback, extracting release artifacts into apps/web/public/updates, editing latest-wails.json, or bumping apps/bcai-wails/updater.go AppVersion.
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

Schema-sensitive update:

```powershell
cd C:\Users\Administrator\Desktop\GFA
git pull origin main
powershell -ExecutionPolicy Bypass -File scripts\deploy-update.ps1
```

Use this when Prisma schema may have changed; it backs up `prisma\dev.db` into `backups\`.

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

## Client Update Publishing

Required edits/files:

- Bump `AppVersion` in `apps\bcai-wails\updater.go`.
- Put final assets directly under `apps\web\public\updates\`.
- Edit `apps\web\public\updates\latest-wails.json`.
- Verify every URL referenced by `latest-wails.json` has a matching file in `apps\web\public\updates\` or production static storage.

The Wails build output is `apps\bcai-wails\build\bin\`, but that is not the public update directory. `apps\bcai-wails\build\windows\info.json` is a Wails build template, not the update manifest.

Windows local build example:

```powershell
cd C:\Users\Administrator\Desktop\GFA\apps\bcai-wails
wails build -platform windows/amd64 -clean -ldflags "-s -w -X main.AppVersion=5.1.6"
Copy-Item .\build\bin\BingchaAI.exe ..\..\apps\web\public\updates\BingchaAI-5.1.6.exe
Get-FileHash ..\..\apps\web\public\updates\BingchaAI-5.1.6.exe -Algorithm SHA256
(Get-Item ..\..\apps\web\public\updates\BingchaAI-5.1.6.exe).Length
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

Manifest fields to update: `version`, Windows `url`/`sha256`/`size`, `changelog`, `minVersion`, and platform assets under `macOS` / `linux` as applicable. The client checks `https://bcai.site/updates/latest-wails.json` by default; `BCAI_UPDATE_URL` overrides it for local testing.

Linux caveat: current Linux in-app updater replaces the binary directly from `bcai-update-<version>.tmp`; a `.tar.gz` URL is fine for manual download but does not match auto-update unless extraction support is added.

## Final Verification

- `pnpm start:daemon` reports services ready.
- `curl.exe http://127.0.0.1:3001/api/health` succeeds.
- `netstat -ano | findstr ":3000 :3001"` shows expected listeners.
- For client updates, `/updates/latest-wails.json` is reachable and referenced asset URLs download.

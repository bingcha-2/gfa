# build-release.ps1
# Run on the developer machine to produce a distributable release/ folder.
#
# Prerequisites:
#   - pnpm + Node.js (for build step)
#   - Internet access (downloads portable Node.js + Redis binary)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 -SkipBuild
#
# Output: release/ at the repo root

param(
  [switch]$SkipBuild   # Skip pnpm build (use existing dist/), useful for iteration
)

$ErrorActionPreference = "Stop"

$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDir = Join-Path $repoRoot "release"

# ─── Runtime version pins ────────────────────────────────────────────────────
$NodeVersion  = "22.14.0"   # Node.js LTS (must match major version used in build)
$RedisVersion = "5.0.14.1"  # tporadowski/redis Windows build

$NodeUrl  = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$RedisUrl = "https://github.com/tporadowski/redis/releases/download/v$RedisVersion/Redis-x64-$RedisVersion.zip"

# ─── Helpers ─────────────────────────────────────────────────────────────────
function Write-Step([string]$Msg) {
  Write-Host ""
  Write-Host "==> $Msg" -ForegroundColor Cyan
}

function Get-RemoteFile([string]$Url, [string]$Dest) {
  if (Test-Path $Dest) {
    Write-Host "  [cached] $(Split-Path $Dest -Leaf)"
    return
  }
  Write-Host "  Downloading: $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

function Expand-ToDir([string]$ZipPath, [string]$OutDir) {
  if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
  Expand-Archive -Path $ZipPath -DestinationPath $OutDir
}

function Invoke-Pnpm([string[]]$Args) {
  $pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) ?? (Get-Command pnpm -ErrorAction SilentlyContinue)
  if (-not $pnpm) { throw "pnpm not found - install it first." }
  & $pnpm.Source @Args
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($Args -join ' ') failed." }
}

# ─── Step 1: Build ───────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Step "Building production artifacts (pnpm build)"
  Invoke-Pnpm @("build")
} else {
  Write-Host "Skipping build (-SkipBuild)" -ForegroundColor Yellow
}

# ─── Step 2: Clean release dir ───────────────────────────────────────────────
Write-Step "Preparing release directory"
if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$runtimeDir = Join-Path $releaseDir "runtime"
New-Item -ItemType Directory -Path $runtimeDir | Out-Null

# ─── Step 3: Download portable Node.js ───────────────────────────────────────
Write-Step "Downloading portable Node.js v$NodeVersion"
$tmpDir     = Join-Path $env:TEMP "gfa-build"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$nodeZip    = Join-Path $tmpDir "node.zip"
$nodeExtDir = Join-Path $tmpDir "node-extracted"
Get-RemoteFile $NodeUrl $nodeZip
Expand-ToDir $nodeZip $nodeExtDir
$nodeSubDir = Get-ChildItem $nodeExtDir | Where-Object PSIsContainer | Select-Object -First 1
# Copy node.exe and required runtime DLLs
foreach ($pattern in @("node.exe", "*.dll", "icudt*.dat")) {
  Get-ChildItem -Path $nodeSubDir.FullName -Filter $pattern -ErrorAction SilentlyContinue |
    Copy-Item -Destination $runtimeDir
}
Write-Host "  Copied node.exe to runtime/"

# ─── Step 4: Download Redis for Windows ──────────────────────────────────────
Write-Step "Downloading Redis for Windows v$RedisVersion"
$redisZip    = Join-Path $tmpDir "redis.zip"
$redisExtDir = Join-Path $tmpDir "redis-extracted"
Get-RemoteFile $RedisUrl $redisZip
Expand-ToDir $redisZip $redisExtDir
Get-ChildItem -Path $redisExtDir -Filter "redis-server.exe" -Recurse |
  Select-Object -First 1 |
  Copy-Item -Destination $runtimeDir
Get-ChildItem -Path $redisExtDir -Filter "*.dll" -Recurse |
  Copy-Item -Destination $runtimeDir -ErrorAction SilentlyContinue
Write-Host "  Copied redis-server.exe to runtime/"

# ─── Step 5: Deploy API (pnpm deploy resolves symlinks correctly) ─────────────
# pnpm deploy resolves workspace: deps and hoists node_modules (no symlinks).
# IMPORTANT: pnpm deploy copies only node_modules, not dist/ — we copy dist/ separately.
Write-Step "Deploying API (pnpm deploy --prod)"
$apiDeployDir = Join-Path $releaseDir "apps\api"
Invoke-Pnpm @("--filter", "@gfa/api", "deploy", "--prod", $apiDeployDir)
# Copy compiled output
robocopy (Join-Path $repoRoot "apps\api\dist") (Join-Path $apiDeployDir "dist") /E /NFL /NDL /NJH /NJS | Out-Null
# Copy prisma schema (needed by prisma CLI and @prisma/client at runtime)
robocopy (Join-Path $repoRoot "prisma") (Join-Path $apiDeployDir "prisma") /E /NFL /NDL /NJH /NJS /XF "*.db" "*.db-journal" | Out-Null
Write-Host "  API deployed: node_modules + dist/ + prisma/"

Write-Step "Deploying Worker (pnpm deploy --prod)"
$workerDeployDir = Join-Path $releaseDir "apps\worker"
Invoke-Pnpm @("--filter", "@gfa/worker", "deploy", "--prod", $workerDeployDir)
# Copy compiled output
robocopy (Join-Path $repoRoot "apps\worker\dist") (Join-Path $workerDeployDir "dist") /E /NFL /NDL /NJH /NJS | Out-Null
Write-Host "  Worker deployed: node_modules + dist/"

# ─── Step 6: Next.js standalone output ───────────────────────────────────────
# next build with output:'standalone' produces .next/standalone/ — a self-contained
# server that bundles its own minimal node_modules (no symlinks, no pnpm needed).
Write-Step "Copying Next.js standalone output"
$webStandaloneSrc = Join-Path $repoRoot "apps\web\.next\standalone"
$webStaticSrc     = Join-Path $repoRoot "apps\web\.next\static"
$webPublicSrc     = Join-Path $repoRoot "apps\web\public"
$webDestDir       = Join-Path $releaseDir "apps\web"

if (-not (Test-Path $webStandaloneSrc)) {
  throw "apps/web/.next/standalone not found. Did you enable output:'standalone' in next.config.ts and run pnpm build?"
}

New-Item -ItemType Directory -Path $webDestDir -Force | Out-Null

# Copy standalone server + bundled node_modules
$roboCopyArgs = @($webStandaloneSrc, $webDestDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS")
robocopy @roboCopyArgs | Out-Null

# Copy static assets and public folder (Next.js requires these alongside standalone)
$webStaticDest  = Join-Path $webDestDir ".next\static"
$webPublicDest  = Join-Path $webDestDir "public"
robocopy $webStaticSrc $webStaticDest /E /NFL /NDL /NJH /NJS | Out-Null
if (Test-Path $webPublicSrc) {
  robocopy $webPublicSrc $webPublicDest /E /NFL /NDL /NJH /NJS | Out-Null
}

# ─── Step 7: Shared package ──────────────────────────────────────────────────
Write-Step "Copying shared package"
$sharedDest = Join-Path $releaseDir "packages\shared\dist"
robocopy (Join-Path $repoRoot "packages\shared\dist") $sharedDest /E /NFL /NDL /NJH /NJS | Out-Null

# ─── Step 8: Prisma schema + runtime scripts ──────────────────────────────────
Write-Step "Copying prisma + scripts"
robocopy (Join-Path $repoRoot "prisma") (Join-Path $releaseDir "prisma") /E /NFL /NDL /NJH /NJS /XF "*.db" "*.db-journal" | Out-Null
robocopy (Join-Path $repoRoot "scripts") (Join-Path $releaseDir "scripts") /E /NFL /NDL /NJH /NJS `
  /XD "__pycache__" /XF "*.png" "*.txt" "build-release.ps1" "installer.iss" "*.ts" "*.py" | Out-Null

# ─── Step 9: Launcher files ───────────────────────────────────────────────────
Write-Step "Copying launcher files"
foreach ($f in @("Start-GFA.bat", "Stop-GFA.bat", "Status-GFA.bat", ".env.example")) {
  Copy-Item (Join-Path $repoRoot $f) (Join-Path $releaseDir $f)
}

# ─── Step 10: Update Get-ServiceDefinitions for standalone web ────────────────
# The standalone Next.js server entry is at: apps/web/server.js (not next start)
# We write a small shim that overrides the web service args in the release.
$shimPath = Join-Path $releaseDir "scripts\private-hosting\web-server-args.txt"
New-Item -ItemType File -Path $shimPath -Force | Out-Null
"standalone" | Set-Content $shimPath -Encoding utf8

# ─── Step 11: Version file ───────────────────────────────────────────────────
Write-Step "Writing version info"
@{
  version = (Get-Date).ToString("yyyy.MM.dd")
  builtAt = (Get-Date -Format "o")
  node    = $NodeVersion
  redis   = $RedisVersion
} | ConvertTo-Json | Set-Content (Join-Path $releaseDir "version.json") -Encoding utf8

$sizeMb = [math]::Round(
  (Get-ChildItem $releaseDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB,
  1
)
Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Release ready: $releaseDir" -ForegroundColor Green
Write-Host "  Total size:    $sizeMb MB"
Write-Host ""
Write-Host "Next: compile installer (requires Inno Setup 6):" -ForegroundColor Cyan
Write-Host "  iscc scripts\installer.iss" -ForegroundColor White

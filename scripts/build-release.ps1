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

function Invoke-Pnpm([string[]]$PnpmArgs) {
  $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpm) { $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
  if (-not $pnpm) { throw "pnpm not found - install it first." }
  & $pnpm.Source @PnpmArgs
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') failed." }
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

# ─── Step 5: Bundle API with ncc (single-file, no node_modules) ──────────────
# @vercel/ncc inlines all JS deps into one file. Only native binary files
# (.prisma/client query engines) need to be copied separately.
Write-Step "Bundling API with ncc"
$apiDeployDir = Join-Path $releaseDir "apps\api"
New-Item -ItemType Directory -Path $apiDeployDir -Force | Out-Null

# ncc compiles dist/main.js + all node_modules into a single bundle.js
# Externalize @prisma/client because it uses native .node binaries ncc can't inline
$nccApiOut = Join-Path $apiDeployDir "dist"
& npx --yes @vercel/ncc build (Join-Path $repoRoot "apps\api\dist\main.js") `
  --out $nccApiOut `
  --external "@prisma/client" `
  --external ".prisma" `
  --no-source-map-register `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "ncc bundle of API failed." }

# Copy Prisma native binaries (query engine .dll/.node files)
$prismaClientSrc = Join-Path $repoRoot "node_modules\.prisma"
if (Test-Path $prismaClientSrc) {
  robocopy $prismaClientSrc (Join-Path $apiDeployDir "node_modules\.prisma") /E /NFL /NDL /NJH /NJS | Out-Null
}
$prismaClientPkgSrc = Join-Path $repoRoot "node_modules\@prisma\client"
if (Test-Path $prismaClientPkgSrc) {
  robocopy $prismaClientPkgSrc (Join-Path $apiDeployDir "node_modules\@prisma\client") /E /NFL /NDL /NJH /NJS | Out-Null
}
# Copy prisma schema (needed by @prisma/client to locate the DB)
robocopy (Join-Path $repoRoot "prisma") (Join-Path $apiDeployDir "prisma") /E /NFL /NDL /NJH /NJS /XF "*.db" "*.db-journal" | Out-Null
Write-Host "  API bundled: dist/index.js (~5MB) + prisma native binaries"

# ─── Step 6: Bundle Worker with ncc ──────────────────────────────────────────
Write-Step "Bundling Worker with ncc"
$workerDeployDir = Join-Path $releaseDir "apps\worker"
New-Item -ItemType Directory -Path $workerDeployDir -Force | Out-Null

$nccWorkerOut = Join-Path $workerDeployDir "dist"
& npx --yes @vercel/ncc build (Join-Path $repoRoot "apps\worker\dist\index.js") `
  --out $nccWorkerOut `
  --external "@prisma/client" `
  --external ".prisma" `
  --external "playwright" `
  --external "playwright-core" `
  --no-source-map-register `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "ncc bundle of Worker failed." }

# Share prisma native binaries (symlink-free: just reuse api's copy)
# Worker reads prisma from its own node_modules path
$workerNmDir = Join-Path $workerDeployDir "node_modules"
New-Item -ItemType Directory -Path $workerNmDir -Force | Out-Null
if (Test-Path $prismaClientSrc) {
  robocopy $prismaClientSrc (Join-Path $workerNmDir ".prisma") /E /NFL /NDL /NJH /NJS | Out-Null
}
if (Test-Path $prismaClientPkgSrc) {
  robocopy $prismaClientPkgSrc (Join-Path $workerNmDir "@prisma\client") /E /NFL /NDL /NJH /NJS | Out-Null
}
# Copy playwright-core (needed for CDP browser automation)
$playwrightCoreSrc = Join-Path $repoRoot "node_modules\playwright-core"
if (Test-Path $playwrightCoreSrc) {
  robocopy $playwrightCoreSrc (Join-Path $workerNmDir "playwright-core") /E /NFL /NDL /NJH /NJS | Out-Null
}
$playwrightSrc = Join-Path $repoRoot "node_modules\playwright"
if (Test-Path $playwrightSrc) {
  robocopy $playwrightSrc (Join-Path $workerNmDir "playwright") /E /NFL /NDL /NJH /NJS | Out-Null
}
Write-Host "  Worker bundled: dist/index.js (~5MB) + prisma + playwright-core"

# ─── Step 6: Package Web via Next.js standalone output ───────────────────────
# output:'standalone' (in next.config.ts) must be built once with admin rights
# (Windows needs symlink privilege for the first build).
# Standalone bundles only the minimal required node_modules (~58MB vs ~484MB).
Write-Step "Packaging Web (Next.js standalone)"
$webDeployDir      = Join-Path $releaseDir "apps\web"
$webStandaloneSrc  = Join-Path $repoRoot "apps\web\.next\standalone"
$webStaticSrc      = Join-Path $repoRoot "apps\web\.next\static"
$webPublicSrc      = Join-Path $repoRoot "apps\web\public"

if (-not (Test-Path $webStandaloneSrc)) {
  Write-Host "  WARN: standalone not found, falling back to pnpm deploy" -ForegroundColor Yellow
  $webDeployDir = Join-Path $releaseDir "apps\web"
  Invoke-Pnpm @("--filter", "@gfa/web", "deploy", "--prod", "--legacy", $webDeployDir)
  robocopy (Join-Path $repoRoot "apps\web\.next") (Join-Path $webDeployDir ".next") /E /NFL /NDL /NJH /NJS /XD "cache" | Out-Null
} else {
  New-Item -ItemType Directory -Path $webDeployDir -Force | Out-Null
  # standalone/ contains server.js + minimal node_modules
  robocopy $webStandaloneSrc $webDeployDir /E /NFL /NDL /NJH /NJS | Out-Null
  # .next/static must be at <webDir>/.next/static
  robocopy $webStaticSrc (Join-Path $webDeployDir ".next\static") /E /NFL /NDL /NJH /NJS | Out-Null
  if (Test-Path $webPublicSrc) {
    robocopy $webPublicSrc (Join-Path $webDeployDir "public") /E /NFL /NDL /NJH /NJS | Out-Null
  }
  Write-Host "  Web packaged via standalone: ~58MB (no full node_modules needed)"
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


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

function Invoke-Pnpm([string[]]$PnpmArgs, [string]$WorkingDirectory = $repoRoot) {
  $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpm) { $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
  if (-not $pnpm) { throw "pnpm not found - install it first." }

  $previousLocation = Get-Location
  $previousCi = [Environment]::GetEnvironmentVariable("CI", "Process")

  try {
    Set-Location $WorkingDirectory
    [Environment]::SetEnvironmentVariable("CI", "true", "Process")
    & $pnpm.Source @PnpmArgs
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') failed." }
  } finally {
    [Environment]::SetEnvironmentVariable("CI", $previousCi, "Process")
    Set-Location $previousLocation
  }
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
$apiDeployDir = Join-Path $releaseDir "apps\server"
New-Item -ItemType Directory -Path $apiDeployDir -Force | Out-Null

# ncc compiles dist/main.js + all node_modules into a single bundle.js
# Externalize @prisma/client because it uses native .node binaries ncc can't inline
$nccApiOut = Join-Path $apiDeployDir "dist"
& npx --yes @vercel/ncc build (Join-Path $repoRoot "apps\server\dist\main.js") `
  --out $nccApiOut `
  --external "@prisma/client" `
  --external ".prisma" `
  --external "bcrypt" `
  --no-source-map-register `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "ncc bundle of API failed." }

$apiBundlePath = Join-Path $nccApiOut "index.js"
$apiMainPath = Join-Path $nccApiOut "main.js"
if (Test-Path $apiBundlePath) {
  if (Test-Path $apiMainPath) {
    Remove-Item $apiMainPath -Force
  }
  Move-Item $apiBundlePath $apiMainPath
}

$prismaRuntimeSrc = Get-ChildItem -Path (Join-Path $repoRoot "node_modules\.pnpm") -Recurse -Directory -Filter ".prisma" |
  Select-Object -First 1 -ExpandProperty FullName
$prismaClientPkgSrc = Join-Path $repoRoot "node_modules\@prisma\client"
$prismaClientVersion = (Get-Content -Raw (Join-Path $prismaClientPkgSrc "package.json") | ConvertFrom-Json).version
$prismaCliVersion = (Get-Content -Raw (Join-Path $repoRoot "node_modules\prisma\package.json") | ConvertFrom-Json).version
$bcryptVersion = (Get-Content -Raw (Join-Path $repoRoot "apps\server\node_modules\bcrypt\package.json") | ConvertFrom-Json).version

$apiRuntimeInstallTemp = Join-Path $tmpDir "api-runtime-install"
if (Test-Path $apiRuntimeInstallTemp) {
  Remove-Item $apiRuntimeInstallTemp -Recurse -Force
}
New-Item -ItemType Directory -Path $apiRuntimeInstallTemp -Force | Out-Null
$apiRuntimePackage = @{
  name = "@gfa/server-runtime"
  private = $true
  version = "0.1.0"
  packageManager = "pnpm@10.27.0"
  dependencies = @{
    "@prisma/client" = $prismaClientVersion
    prisma = $prismaCliVersion
    bcrypt = $bcryptVersion
  }
}
$apiRuntimePackage |
  ConvertTo-Json -Depth 10 |
  Set-Content (Join-Path $apiRuntimeInstallTemp "package.json") -Encoding utf8
Invoke-Pnpm @("install", "--prod", "--ignore-scripts", "--config.node-linker=hoisted") $apiRuntimeInstallTemp
robocopy (Join-Path $apiRuntimeInstallTemp "node_modules") (Join-Path $apiDeployDir "node_modules") /E /NFL /NDL /NJH /NJS | Out-Null

# Copy Prisma runtime + CLI files needed for bundled DB init/seed
if ($prismaRuntimeSrc) {
  robocopy $prismaRuntimeSrc (Join-Path $apiDeployDir "node_modules\.prisma") /E /NFL /NDL /NJH /NJS | Out-Null
}
robocopy $prismaClientPkgSrc (Join-Path $apiDeployDir "node_modules\@prisma\client") /E /NFL /NDL /NJH /NJS | Out-Null
# Copy prisma schema (needed by @prisma/client to locate the DB)
robocopy (Join-Path $repoRoot "prisma") (Join-Path $apiDeployDir "prisma") /E /NFL /NDL /NJH /NJS /XF "*.db" "*.db-journal" | Out-Null
Write-Host "  API bundled: dist/main.js (~5MB) + prisma runtime + bcrypt"

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

$playwrightVersion = (Get-Content -Raw (Join-Path $repoRoot "apps\worker\node_modules\playwright\package.json") | ConvertFrom-Json).version
$workerRuntimeInstallTemp = Join-Path $tmpDir "worker-runtime-install"
if (Test-Path $workerRuntimeInstallTemp) {
  Remove-Item $workerRuntimeInstallTemp -Recurse -Force
}
New-Item -ItemType Directory -Path $workerRuntimeInstallTemp -Force | Out-Null
$workerRuntimePackage = @{
  name = "@gfa/worker-runtime"
  private = $true
  version = "0.1.0"
  packageManager = "pnpm@10.27.0"
  dependencies = @{
    playwright = $playwrightVersion
  }
}
$workerRuntimePackage |
  ConvertTo-Json -Depth 10 |
  Set-Content (Join-Path $workerRuntimeInstallTemp "package.json") -Encoding utf8
Invoke-Pnpm @("install", "--prod", "--ignore-scripts", "--config.node-linker=hoisted") $workerRuntimeInstallTemp
robocopy (Join-Path $workerRuntimeInstallTemp "node_modules") $workerNmDir /E /NFL /NDL /NJH /NJS | Out-Null

if ($prismaRuntimeSrc) {
  robocopy $prismaRuntimeSrc (Join-Path $workerNmDir ".prisma") /E /NFL /NDL /NJH /NJS | Out-Null
}
if (Test-Path $prismaClientPkgSrc) {
  robocopy $prismaClientPkgSrc (Join-Path $workerNmDir "@prisma\client") /E /NFL /NDL /NJH /NJS | Out-Null
}
Write-Host "  Worker bundled: dist/index.js (~5MB) + prisma + playwright-core"

# ─── Step 7: Package Web via standalone when available, otherwise pnpm deploy ─
Write-Step "Packaging Web"
$webDeployDir      = Join-Path $releaseDir "apps\web"
$webStandaloneSrc  = Join-Path $repoRoot "apps\web\.next\standalone"
$webStaticSrc      = Join-Path $repoRoot "apps\web\.next\static"
$webPublicSrc      = Join-Path $repoRoot "apps\web\public"
$webLaunchMode     = "next-start"
$webStandaloneServer = Join-Path $webStandaloneSrc "apps\web\server.js"

if ((Test-Path $webStandaloneSrc) -and (Test-Path $webStandaloneServer)) {
  $webLaunchMode = "standalone"
  New-Item -ItemType Directory -Path $webDeployDir -Force | Out-Null
  # standalone/ contains the traced runtime tree for the web app
  robocopy $webStandaloneSrc $webDeployDir /E /NFL /NDL /NJH /NJS | Out-Null
  # .next/static must be at <webDir>/.next/static
  robocopy $webStaticSrc (Join-Path $webDeployDir ".next\static") /E /NFL /NDL /NJH /NJS | Out-Null
  if (Test-Path $webPublicSrc) {
    robocopy $webPublicSrc (Join-Path $webDeployDir "public") /E /NFL /NDL /NJH /NJS | Out-Null
  }
  Write-Host "  Web packaged via standalone runtime"
} else {
  Write-Host "  Standalone runtime unavailable, installing runtime dependencies directly" -ForegroundColor Yellow
  New-Item -ItemType Directory -Path $webDeployDir -Force | Out-Null
  $webSourcePackage = Get-Content -Raw (Join-Path $repoRoot "apps\web\package.json") | ConvertFrom-Json
  $webNextVersion = $webSourcePackage.dependencies.next
  $webReactVersion = $webSourcePackage.dependencies.react
  $webReactDomVersion = $webSourcePackage.dependencies."react-dom"
  $webInstallTemp = Join-Path $tmpDir "web-runtime-install"

  if (Test-Path $webInstallTemp) {
    Remove-Item $webInstallTemp -Recurse -Force
  }

  New-Item -ItemType Directory -Path $webInstallTemp -Force | Out-Null

  $webRuntimePackage = @{
    name = "@gfa/web-runtime"
    private = $true
    version = "0.1.0"
    packageManager = "pnpm@10.27.0"
    dependencies = @{
      next = $webNextVersion
      react = $webReactVersion
      "react-dom" = $webReactDomVersion
    }
  }

  $webRuntimePackage |
    ConvertTo-Json -Depth 10 |
    Set-Content (Join-Path $webInstallTemp "package.json") -Encoding utf8

  Invoke-Pnpm @("install", "--prod", "--ignore-scripts", "--config.node-linker=hoisted") $webInstallTemp
  robocopy $webInstallTemp $webDeployDir /E /NFL /NDL /NJH /NJS | Out-Null
  robocopy (Join-Path $repoRoot "apps\web\.next") (Join-Path $webDeployDir ".next") /E /NFL /NDL /NJH /NJS /XD "cache" | Out-Null
  if (Test-Path $webPublicSrc) {
    robocopy $webPublicSrc (Join-Path $webDeployDir "public") /E /NFL /NDL /NJH /NJS | Out-Null
  }
  Write-Host "  Web packaged via runtime dependency install"
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

# ─── Step 10: Record web launch mode for the bundled launcher ─────────────────
$shimPath = Join-Path $releaseDir "scripts\private-hosting\web-server-args.txt"
New-Item -ItemType File -Path $shimPath -Force | Out-Null
$webLaunchMode | Set-Content $shimPath -Encoding utf8

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


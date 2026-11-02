param(
  [Parameter(Mandatory = $true)]
  [string]$MigrationDirectory,

  [string]$InstallRoot = "C:\GFA",
  [string]$RuntimeRoot = "C:\GFA-runtime",
  [string]$AdsPowerProgramRoot = "C:\Apps",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host ("==> {0}" -f $Message) -ForegroundColor Cyan
}

function Assert-LastExitCode([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

$migrationRoot = (Resolve-Path -LiteralPath $MigrationDirectory).Path
$manifestPath = Join-Path $migrationRoot "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "manifest.json was not found in $migrationRoot"
}

Write-Step "Verifying migration archives"
$manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
foreach ($entry in $manifest) {
  $path = Join-Path $migrationRoot $entry.file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Migration file is missing: $($entry.file)"
  }
  $item = Get-Item -LiteralPath $path
  if ($item.Length -ne [int64]$entry.bytes) {
    throw "Size mismatch for $($entry.file)"
  }
  $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne [string]$entry.sha256) {
    throw "SHA-256 mismatch for $($entry.file)"
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  $existing = Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing -and -not $Force) {
    throw "$InstallRoot is not empty. Choose another InstallRoot or rerun with -Force after reviewing it."
  }
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

Write-Step "Restoring GFA code and production database"
& tar.exe -xzf (Join-Path $migrationRoot "gfa-code.tar.gz") -C $InstallRoot
Assert-LastExitCode "Extracting GFA code"
& tar.exe -xzf (Join-Path $migrationRoot "gfa-database.tar.gz") -C $InstallRoot
Assert-LastExitCode "Extracting the production database"

$backupArchive = Join-Path $migrationRoot "gfa-backups.tar.gz"
if (Test-Path -LiteralPath $backupArchive) {
  & tar.exe -xzf $backupArchive -C $InstallRoot
  Assert-LastExitCode "Extracting historical backups"
}

$caddyArchive = Join-Path $migrationRoot "caddy.tar.gz"
$caddyRoot = Join-Path $RuntimeRoot "caddy"
if (Test-Path -LiteralPath $caddyArchive) {
  New-Item -ItemType Directory -Path $caddyRoot -Force | Out-Null
  & tar.exe -xzf $caddyArchive -C $caddyRoot
  Assert-LastExitCode "Extracting Caddy"

  $caddyfile = Join-Path $caddyRoot "Caddyfile"
  $installRootForCaddy = $InstallRoot.Replace("\", "/")
  $content = Get-Content -LiteralPath $caddyfile -Raw
  $content = $content.Replace("D:/GFA-per", $installRootForCaddy)
  Set-Content -LiteralPath $caddyfile -Value $content -Encoding utf8
}

$adsPowerDataArchive = Join-Path $migrationRoot "adspower-data.tar.gz"
if (Test-Path -LiteralPath $adsPowerDataArchive) {
  New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null
  & tar.exe -xzf $adsPowerDataArchive -C $env:APPDATA
  Assert-LastExitCode "Extracting AdsPower user data"
}

$adsPowerProgramArchive = Join-Path $migrationRoot "adspower-program.tar.gz"
if (Test-Path -LiteralPath $adsPowerProgramArchive) {
  New-Item -ItemType Directory -Path $AdsPowerProgramRoot -Force | Out-Null
  & tar.exe -xzf $adsPowerProgramArchive -C $AdsPowerProgramRoot
  Assert-LastExitCode "Extracting AdsPower program files"
}

Write-Step "Installing Node.js and pnpm"
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Node.js is missing and winget is unavailable. Install Node.js LTS, then rerun this script."
  }

  & $winget.Source install --exact --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  Assert-LastExitCode "Installing Node.js LTS"
  Refresh-ProcessPath
}

$requiredPnpmVersion = "10.27.0"
$currentPnpmVersion = try { (& pnpm.cmd --version).Trim() } catch { $null }
if ($currentPnpmVersion -ne $requiredPnpmVersion) {
  & npm.cmd install --global "pnpm@$requiredPnpmVersion"
  Assert-LastExitCode "Installing pnpm $requiredPnpmVersion"
  Refresh-ProcessPath
}

Write-Step "Installing GFA dependencies"
Push-Location $InstallRoot
try {
  & pnpm.cmd install --frozen-lockfile
  Assert-LastExitCode "pnpm install"

  & pnpm.cmd db:generate
  Assert-LastExitCode "Generating the Prisma client"

  & pnpm.cmd db:migrate:status
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Prisma migration status needs review. No migrations were applied automatically."
  }
} finally {
  Pop-Location
}

Write-Step "Opening Windows Firewall ports for HTTP/HTTPS"
foreach ($port in @(80, 443)) {
  $ruleName = "GFA inbound TCP $port"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
  }
}

Write-Host ""
Write-Host "Target restore completed." -ForegroundColor Green
Write-Host "Next: start AdsPower once, then run migration-kit\start-target.ps1 -SkipCaddy."
Write-Host "After DNS points to this host, run start-target.ps1 again without -SkipCaddy."

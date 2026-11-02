param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [bool]$IncludeHistoricalBackups = $true,
  [bool]$IncludeAdsPower = $true
)

$ErrorActionPreference = "Stop"

$kitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $kitRoot "..")).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host ("==> {0}" -f $Message) -ForegroundColor Cyan
}

function Assert-LastExitCode([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Get-ListeningProcess([int]$Port) {
  try {
    return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    return $null
  }
}

function Assert-FileStable([string]$Path, [int]$Seconds = 3) {
  $first = Get-Item -LiteralPath $Path
  Start-Sleep -Seconds $Seconds
  $second = Get-Item -LiteralPath $Path

  if ($first.Length -ne $second.Length -or $first.LastWriteTimeUtc -ne $second.LastWriteTimeUtc) {
    throw "File is still changing: $Path"
  }
}

function New-TarArchive(
  [string]$ArchivePath,
  [string]$WorkingDirectory,
  [string[]]$Items,
  [string[]]$Excludes = @()
) {
  $arguments = @("-czf", $ArchivePath)

  foreach ($exclude in $Excludes) {
    $arguments += "--exclude=$exclude"
  }

  $arguments += "-C"
  $arguments += $WorkingDirectory
  $arguments += $Items

  & tar.exe @arguments
  Assert-LastExitCode "Creating $(Split-Path -Leaf $ArchivePath)"
}

Write-Step "Checking source state"

$requiredPaths = @(
  (Join-Path $repoRoot ".env"),
  (Join-Path $repoRoot "prisma\dev.db"),
  (Join-Path $repoRoot "package.json"),
  (Join-Path $repoRoot "pnpm-lock.yaml")
)

foreach ($path in $requiredPaths) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required migration input is missing: $path"
  }
}

$busyPorts = foreach ($port in @(3000, 3001)) {
  $connection = Get-ListeningProcess $port
  if ($connection) {
    [pscustomobject]@{ Port = $port; ProcessId = $connection.OwningProcess }
  }
}

if ($busyPorts) {
  $description = ($busyPorts | ForEach-Object { "$($_.Port) (PID $($_.ProcessId))" }) -join ", "
  throw "GFA is still listening on $description. Run 'pnpm.cmd start:stop' first."
}

$adsPowerProcesses = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -match "(?i)adspower" } catch { $false }
}

if ($IncludeAdsPower -and $adsPowerProcesses) {
  throw "AdsPower is still running. Close it before archiving its browser profiles."
}

$databasePath = Join-Path $repoRoot "prisma\dev.db"
Assert-FileStable $databasePath

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path

if ($outputRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be outside the repository to avoid recursive archives."
}

$migrationRoot = Join-Path $outputRoot "GFA-migration-$timestamp"
New-Item -ItemType Directory -Path $migrationRoot -Force | Out-Null

Write-Step "Copying migration scripts"
Copy-Item -LiteralPath (Join-Path $kitRoot "README.md") -Destination $migrationRoot
Copy-Item -LiteralPath (Join-Path $kitRoot "install-target.ps1") -Destination $migrationRoot
Copy-Item -LiteralPath (Join-Path $kitRoot "start-target.ps1") -Destination $migrationRoot
Copy-Item -LiteralPath (Join-Path $kitRoot "verify-database.mjs") -Destination $migrationRoot

$journalPath = Join-Path $repoRoot "prisma\dev.db-journal"
if (Test-Path -LiteralPath $journalPath) {
  Copy-Item -LiteralPath $journalPath -Destination (Join-Path $migrationRoot "pre-recovery-dev.db-journal")
}

Write-Step "Recovering SQLite if needed and checking database integrity"
& node.exe (Join-Path $kitRoot "verify-database.mjs") $databasePath
Assert-LastExitCode "SQLite integrity check"

Write-Step "Archiving application code and configuration"
$codeArchive = Join-Path $migrationRoot "gfa-code.tar.gz"
$codeExcludes = @(
  ".git",
  "node_modules",
  ".next",
  ".codex-deps",
  ".tmp",
  "logs",
  "backups",
  "exports",
  "recovered-codex-conversations",
  "_new-api-work",
  "_deprecated",
  "prisma/*.db",
  "prisma/*.db-*",
  "dev.db",
  "gfa.pid",
  "artifacts/private-hosting/logs",
  "artifacts/private-hosting/state.json",
  "artifacts/private-hosting/redis-state.json"
)
New-TarArchive -ArchivePath $codeArchive -WorkingDirectory $repoRoot -Items @(".") -Excludes $codeExcludes

Write-Step "Archiving the production SQLite database"
$databaseItems = @("prisma/dev.db")
if (Test-Path -LiteralPath $journalPath) {
  Assert-FileStable $journalPath
  $databaseItems += "prisma/dev.db-journal"
}

$databaseArchive = Join-Path $migrationRoot "gfa-database.tar.gz"
New-TarArchive -ArchivePath $databaseArchive -WorkingDirectory $repoRoot -Items $databaseItems

if ($IncludeHistoricalBackups -and (Test-Path -LiteralPath (Join-Path $repoRoot "backups"))) {
  Write-Step "Archiving historical backups"
  New-TarArchive `
    -ArchivePath (Join-Path $migrationRoot "gfa-backups.tar.gz") `
    -WorkingDirectory $repoRoot `
    -Items @("backups")
}

$caddyDirectory = "C:\Users\Administrator\Desktop\caddy"
if (Test-Path -LiteralPath (Join-Path $caddyDirectory "Caddyfile")) {
  Write-Step "Archiving Caddy"
  $caddyItems = @("Caddyfile")
  foreach ($optionalName in @("caddy.exe", "LICENSE", "README.md")) {
    if (Test-Path -LiteralPath (Join-Path $caddyDirectory $optionalName)) {
      $caddyItems += $optionalName
    }
  }
  New-TarArchive `
    -ArchivePath (Join-Path $migrationRoot "caddy.tar.gz") `
    -WorkingDirectory $caddyDirectory `
    -Items $caddyItems
}

$adsPowerData = Join-Path $env:APPDATA "adspower_global"
$adsPowerInstall = "D:\ads\AdsPower Global"

if ($IncludeAdsPower -and (Test-Path -LiteralPath $adsPowerData)) {
  Write-Step "Archiving AdsPower user data"
  New-TarArchive `
    -ArchivePath (Join-Path $migrationRoot "adspower-data.tar.gz") `
    -WorkingDirectory (Split-Path -Parent $adsPowerData) `
    -Items @((Split-Path -Leaf $adsPowerData))
}

if ($IncludeAdsPower -and (Test-Path -LiteralPath $adsPowerInstall)) {
  Write-Step "Archiving AdsPower program files"
  New-TarArchive `
    -ArchivePath (Join-Path $migrationRoot "adspower-program.tar.gz") `
    -WorkingDirectory (Split-Path -Parent $adsPowerInstall) `
    -Items @((Split-Path -Leaf $adsPowerInstall))
}

Write-Step "Writing inventory and SHA-256 manifest"
$nodeVersion = try { (& node.exe --version) } catch { $null }
$pnpmVersion = try { (& pnpm.cmd --version) } catch { $null }
$database = Get-Item -LiteralPath $databasePath

$inventory = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  sourceHost = $env:COMPUTERNAME
  sourceRepo = $repoRoot
  nodeVersion = $nodeVersion
  pnpmVersion = $pnpmVersion
  databaseBytes = $database.Length
  databaseLastWriteUtc = $database.LastWriteTimeUtc.ToString("o")
  databaseJournalIncluded = (Test-Path -LiteralPath $journalPath)
  adsPowerVersion = "8.4.3"
  warning = "Archives contain .env secrets and browser profile data."
}
$inventory | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $migrationRoot "inventory.json") -Encoding utf8

$manifest = Get-ChildItem -LiteralPath $migrationRoot -File |
  Where-Object { $_.Name -ne "manifest.json" } |
  Sort-Object Name |
  ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    [ordered]@{
      file = $_.Name
      bytes = $_.Length
      sha256 = $hash.Hash.ToLowerInvariant()
    }
  }

$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $migrationRoot "manifest.json") -Encoding utf8

Write-Host ""
Write-Host "Migration set ready:" -ForegroundColor Green
Write-Host $migrationRoot
Get-ChildItem -LiteralPath $migrationRoot -File |
  Select-Object Name, @{ Name = "GB"; Expression = { [math]::Round($_.Length / 1GB, 3) } } |
  Format-Table -AutoSize

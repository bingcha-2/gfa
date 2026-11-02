param(
  [string]$SourceRepo = "\\tsclient\D\GFA-per",
  [string]$SourceUserProfile = "\\tsclient\C\Users\Administrator",
  [string]$InstallRoot = "C:\GFA",
  [string]$RuntimeRoot = "C:\GFA-runtime",
  [string]$AdsPowerProgramRoot = "C:\Apps",
  [switch]$SkipAdsPower,
  [switch]$SkipHistoricalBackups,
  [switch]$SkipStart
)

$ErrorActionPreference = "Stop"
$robocopyLog = Join-Path $PSScriptRoot ("robocopy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host ("==> {0}" -f $Message) -ForegroundColor Cyan
}

function Invoke-Robocopy([string[]]$Arguments, [string]$Operation) {
  $effectiveArguments = $Arguments + @("/TEE", "/LOG+:$robocopyLog")
  & robocopy.exe @effectiveArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "$Operation failed with robocopy exit code $exitCode. See $robocopyLog"
  }
}

if (-not (Test-Path -LiteralPath $SourceRepo)) {
  throw "RDP source drive is unavailable: $SourceRepo. Reconnect with drive redirection enabled."
}

foreach ($required in @(".env", "package.json", "pnpm-lock.yaml", "prisma\dev.db")) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRepo $required))) {
    throw "Required source item is missing: $required"
  }
}

Write-Step "Copying GFA code and configuration from the redirected source drive"
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

# Copy only known production inputs. A repository-wide /E walk can traverse
# large local workspaces and recovery folders that are unrelated to GFA.
$rootFiles = @(
  ".env", ".env.local", ".env.example", ".gitignore", ".gitattributes",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json",
  "Caddyfile", "Caddyfile.migration", "DEPLOY-split-domain.md", "README.md",
  "PRODUCT.md", "docker-compose.yml", "ecosystem.config.js", "dev-local.sh",
  "rosetta-certs.zip", "rosetta-data.zip"
)
$rootCopyArguments = @(
  $SourceRepo, $InstallRoot
) + $rootFiles + @(
  "/LEV:1", "/Z", "/R:5", "/W:5", "/COPY:DAT", "/DCOPY:DAT", "/XJ"
)
Invoke-Robocopy $rootCopyArguments "Copying GFA root configuration"

$productionDirectories = @(
  [pscustomobject]@{ Relative = "apps"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "packages"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "scripts"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "prisma"; ExcludeDatabases = $true },
  [pscustomobject]@{ Relative = "artifacts\private-hosting\runtime"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "deploy"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "docs"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "tests"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = ".github"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = ".agents"; ExcludeDatabases = $false },
  [pscustomobject]@{ Relative = "migration-kit"; ExcludeDatabases = $false }
)

foreach ($directory in $productionDirectories) {
  $sourceDirectory = Join-Path $SourceRepo $directory.Relative
  if (-not (Test-Path -LiteralPath $sourceDirectory)) {
    continue
  }

  $targetDirectory = Join-Path $InstallRoot $directory.Relative
  $directoryCopyArguments = @(
    $sourceDirectory, $targetDirectory, "/E", "/Z", "/R:5", "/W:5",
    "/COPY:DAT", "/DCOPY:DAT", "/XJ", "/MT:4",
    "/XD", "node_modules", ".next", ".git", "logs", ".cache"
  )

  if ($directory.ExcludeDatabases) {
    $directoryCopyArguments += @(
      "/XF", "dev.db", "dev.db-journal", "test.db", "dev-migration.db"
    )
  }

  Invoke-Robocopy $directoryCopyArguments "Copying $($directory.Relative)"
}

Write-Step "Copying the production SQLite database"
New-Item -ItemType Directory -Path (Join-Path $InstallRoot "prisma") -Force | Out-Null
Invoke-Robocopy @(
  (Join-Path $SourceRepo "prisma"),
  (Join-Path $InstallRoot "prisma"),
  "dev.db", "dev.db-journal", "/Z", "/J", "/R:5", "/W:5", "/COPY:DAT"
) "Copying the production database"

$sourceDatabase = Join-Path $SourceRepo "prisma\dev.db"
$targetDatabase = Join-Path $InstallRoot "prisma\dev.db"
$sourceHashMetadataPath = Join-Path $SourceRepo "migration-kit\source-database.json"
if (Test-Path -LiteralPath $sourceHashMetadataPath) {
  $sourceMetadata = Get-Content -LiteralPath $sourceHashMetadataPath -Raw | ConvertFrom-Json
  $currentSourceDatabase = Get-Item -LiteralPath $sourceDatabase
  if ($currentSourceDatabase.Length -ne [int64]$sourceMetadata.bytes) {
    throw "The source database changed after its SHA-256 was recorded. Recreate source-database.json."
  }
  $sourceHash = [string]$sourceMetadata.sha256
} else {
  $sourceHash = (Get-FileHash -LiteralPath $sourceDatabase -Algorithm SHA256).Hash
}
$targetHash = (Get-FileHash -LiteralPath $targetDatabase -Algorithm SHA256).Hash
if ($sourceHash.ToLowerInvariant() -ne $targetHash.ToLowerInvariant()) {
  throw "The production database SHA-256 does not match after transfer."
}

if (-not $SkipHistoricalBackups -and (Test-Path -LiteralPath (Join-Path $SourceRepo "backups"))) {
  Write-Step "Copying historical backups"
  Invoke-Robocopy @(
    (Join-Path $SourceRepo "backups"),
    (Join-Path $InstallRoot "backups"),
    "/E", "/Z", "/J", "/R:3", "/W:3", "/COPY:DAT", "/DCOPY:DAT"
  ) "Copying historical backups"
}

Write-Step "Copying Caddy"
$sourceCaddy = Join-Path $SourceUserProfile "Desktop\caddy"
$targetCaddy = Join-Path $RuntimeRoot "caddy"
if (Test-Path -LiteralPath $sourceCaddy) {
  Invoke-Robocopy @(
    $sourceCaddy, $targetCaddy, "Caddyfile", "caddy.exe", "LICENSE", "README.md",
    "/R:3", "/W:3", "/COPY:DAT"
  ) "Copying Caddy"

  $caddyfile = Join-Path $targetCaddy "Caddyfile"
  if (Test-Path -LiteralPath $caddyfile) {
    $installRootForCaddy = $InstallRoot.Replace("\", "/")
    $content = Get-Content -LiteralPath $caddyfile -Raw
    $content = $content.Replace("D:/GFA-per", $installRootForCaddy)
    Set-Content -LiteralPath $caddyfile -Value $content -Encoding utf8
  }
}

if (-not $SkipAdsPower) {
  Write-Step "Copying AdsPower user profiles"
  $sourceAdsPowerData = Join-Path $SourceUserProfile "AppData\Roaming\adspower_global"
  if (Test-Path -LiteralPath $sourceAdsPowerData) {
    Invoke-Robocopy @(
      $sourceAdsPowerData,
      (Join-Path $env:APPDATA "adspower_global"),
      "/E", "/Z", "/R:3", "/W:3", "/COPY:DAT", "/DCOPY:DAT", "/XJ", "/MT:8"
    ) "Copying AdsPower user profiles"
  }

  Write-Step "Copying AdsPower program files"
  $sourceAdsPowerProgram = "\\tsclient\D\ads\AdsPower Global"
  if (Test-Path -LiteralPath $sourceAdsPowerProgram) {
    Invoke-Robocopy @(
      $sourceAdsPowerProgram,
      (Join-Path $AdsPowerProgramRoot "AdsPower Global"),
      "/E", "/Z", "/R:3", "/W:3", "/COPY:DAT", "/DCOPY:DAT", "/XJ", "/MT:8"
    ) "Copying AdsPower program files"
  }
}

Write-Step "Preparing the Node.js and pnpm runtime"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  $sourceNodeRoot = "\\tsclient\C\Program Files\nodejs"
  $targetNodeRoot = Join-Path $RuntimeRoot "node"
  if (-not (Test-Path -LiteralPath (Join-Path $sourceNodeRoot "node.exe"))) {
    throw "Node.js is missing on the target and the redirected source Node.js runtime is unavailable."
  }
  Invoke-Robocopy @(
    $sourceNodeRoot, $targetNodeRoot, "/E", "/Z", "/R:3", "/W:3", "/COPY:DAT", "/DCOPY:DAT"
  ) "Copying the Node.js runtime"
  $env:Path = "$targetNodeRoot;$env:Path"
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
  $sourcePnpmRoot = Join-Path $SourceUserProfile "AppData\Roaming\npm"
  $targetPnpmRoot = Join-Path $RuntimeRoot "npm-global"
  if (-not (Test-Path -LiteralPath (Join-Path $sourcePnpmRoot "pnpm.cmd"))) {
    throw "pnpm is missing on the target and the redirected source pnpm runtime is unavailable."
  }
  Invoke-Robocopy @(
    $sourcePnpmRoot, $targetPnpmRoot, "/E", "/Z", "/R:3", "/W:3", "/COPY:DAT", "/DCOPY:DAT"
  ) "Copying pnpm"
  $env:Path = "$targetPnpmRoot;$env:Path"
}

Write-Step "Installing GFA dependencies and generating Prisma"
Push-Location $InstallRoot
try {
  & pnpm.cmd install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed with exit code $LASTEXITCODE."
  }

  & pnpm.cmd db:generate
  if ($LASTEXITCODE -ne 0) {
    throw "Prisma client generation failed with exit code $LASTEXITCODE."
  }

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

if (-not $SkipStart) {
  if (-not $SkipAdsPower) {
    $adsPowerExe = Join-Path $AdsPowerProgramRoot "AdsPower Global\AdsPower Global.exe"
    if (Test-Path -LiteralPath $adsPowerExe) {
      Start-Process -FilePath $adsPowerExe
    }
  }

  Write-Step "Starting Redis and GFA for local validation"
  & (Join-Path $InstallRoot "migration-kit\start-target.ps1") `
    -InstallRoot $InstallRoot `
    -RuntimeRoot $RuntimeRoot `
    -SkipCaddy
}

Write-Host ""
Write-Host "RDP pull completed, the database hash matches, and the target runtime is prepared." -ForegroundColor Green
Write-Host "After local validation and DNS cutover, run start-target.ps1 again without -SkipCaddy."

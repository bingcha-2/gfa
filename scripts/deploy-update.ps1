<# 
  deploy-update.ps1
  
  GFA 源码部署更新脚本 — 在客户 Windows 服务器上执行
  适用于通过 pnpm start 运行的源码部署方式
  
  功能：停服务 → 备份数据库 → 安全 schema 迁移 → 重新构建 → 启动服务
  
  用法（在项目根目录下执行）：
    powershell -ExecutionPolicy Bypass -File scripts\deploy-update.ps1
  
  注意：
  - 必须在项目根目录（包含 .env 的目录）下执行
  - 代码更新需要提前完成（git pull 或手动覆盖源文件）
  - 此脚本不会执行 prisma db push，而是使用 prisma migrate diff
    生成差异 SQL 后安全执行，不会丢失现有数据
#>

param(
  [switch]$SkipBuild   # Skip pnpm build (use existing dist/)
)

$ErrorActionPreference = "Stop"

# ── Detect project root ──────────────────────────────────────────────────────
# Script must be called from repo root, OR we auto-detect from script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path

$envPath = Join-Path $ProjectRoot ".env"
$dbPath  = Join-Path $ProjectRoot "prisma\dev.db"

if (-not (Test-Path $envPath)) {
  Write-Host "[ERROR] .env not found in $ProjectRoot" -ForegroundColor Red
  Write-Host "  Make sure this script is located in <project-root>/scripts/" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  GFA Source Deploy Update" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Project Root: $ProjectRoot"
Write-Host "  Database:     $dbPath"
Write-Host ""

# ── Step 1: Stop services ────────────────────────────────────────────────────
Write-Host "==> Step 1: Stopping services" -ForegroundColor Yellow

$pidFile = Join-Path $ProjectRoot "gfa.pid"
if (Test-Path $pidFile) {
  $gfaPid = (Get-Content $pidFile -Raw).Trim()
  try {
    taskkill /T /F /PID $gfaPid 2>$null | Out-Null
    Write-Host "  Stopped process tree (PID: $gfaPid)" -ForegroundColor Green
  } catch {
    Write-Host "  Process $gfaPid already stopped" -ForegroundColor Yellow
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Also kill by port as safety net
foreach ($port in @(3000, 3001)) {
  $netstat = netstat -ano 2>$null | Select-String ":${port}\s"
  foreach ($line in $netstat) {
    if ($line -match '\s+(\d+)\s*$') {
      $procPid = $Matches[1]
      if ($procPid -ne "0") {
        try { taskkill /F /PID $procPid 2>$null | Out-Null } catch {}
        Write-Host "  Killed PID $procPid on port $port" -ForegroundColor Yellow
      }
    }
  }
}

Start-Sleep -Seconds 2
Write-Host "  Services stopped" -ForegroundColor Green

# ── Step 2: Backup database ──────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Step 2: Backing up database" -ForegroundColor Yellow

$backupDir = Join-Path $ProjectRoot "backups"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$backupFile = Join-Path $backupDir "dev-$timestamp.db"

if (Test-Path $dbPath) {
  Copy-Item $dbPath $backupFile
  $sizeMb = [math]::Round((Get-Item $backupFile).Length / 1MB, 2)
  Write-Host "  Backed up: $backupFile ($sizeMb MB)" -ForegroundColor Green
} else {
  Write-Host "  No existing database found (first install)" -ForegroundColor Yellow
}

# ── Step 3: Safe schema migration ────────────────────────────────────────────
Write-Host ""
Write-Host "==> Step 3: Database schema migration (safe diff)" -ForegroundColor Yellow

# Read DATABASE_URL from .env
$dbUrl = "file:./dev.db"
$envContent = Get-Content $envPath -Encoding utf8
foreach ($line in $envContent) {
  if ($line -match '^\s*DATABASE_URL\s*=\s*"?([^"]+)"?') {
    $dbUrl = $Matches[1]
  }
}

# Convert relative file: URL to absolute (Prisma resolves relative to CWD, not prisma/)
if ($dbUrl -match '^file:\.') {
  $relPath = $dbUrl -replace '^file:', ''
  $absDbPath = (Resolve-Path (Join-Path $ProjectRoot "prisma" $relPath) -ErrorAction SilentlyContinue).Path
  if ($absDbPath) {
    $dbUrl = "file:$absDbPath"
  } else {
    $dbUrl = "file:$(Join-Path $ProjectRoot 'prisma' $relPath)"
  }
}

$schemaPath = Join-Path $ProjectRoot "prisma\schema.prisma"

# Use prisma migrate diff to generate safe SQL, then execute
# This NEVER drops tables or columns — only adds what's missing
$env:DATABASE_URL = $dbUrl

if (Test-Path $dbPath) {
  # Existing DB: generate diff
  Write-Host "  Generating schema diff..." -ForegroundColor Gray
  Write-Host "  DB URL: $dbUrl" -ForegroundColor Gray
  
  $diffResult = & npx prisma migrate diff `
    --from-url $dbUrl `
    --to-schema-datamodel $schemaPath `
    --script 2>&1
  
  $diffSql = ($diffResult | Out-String).Trim()
  
  if ($diffSql -match "empty migration" -or [string]::IsNullOrWhiteSpace($diffSql)) {
    Write-Host "  Schema already in sync — no migration needed" -ForegroundColor Green
  } else {
    Write-Host "  Changes detected. SQL to execute:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  $($diffSql -replace "`n", "`n  ")" -ForegroundColor Gray
    Write-Host ""
    
    # Write SQL to temp file and execute
    $tempSql = Join-Path $env:TEMP "gfa-migrate-$timestamp.sql"
    $diffSql | Set-Content $tempSql -Encoding utf8
    
    & npx prisma db execute --file $tempSql --schema $schemaPath 2>&1 | ForEach-Object {
      Write-Host "  $_"
    }
    
    Remove-Item $tempSql -Force -ErrorAction SilentlyContinue
    
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "  [WARNING] Migration may have failed!" -ForegroundColor Red
      Write-Host "  Backup at: $backupFile" -ForegroundColor Yellow
      Write-Host "  To restore: Copy-Item '$backupFile' '$dbPath' -Force" -ForegroundColor Yellow
      
      $continue = Read-Host "  Continue anyway? (y/N)"
      if ($continue -ne "y") {
        Copy-Item $backupFile $dbPath -Force
        Write-Host "  Database restored from backup." -ForegroundColor Green
        exit 1
      }
    } else {
      Write-Host "  Migration applied successfully" -ForegroundColor Green
    }
  }
} else {
  # No DB: full init
  Write-Host "  No database found, running full init..." -ForegroundColor Yellow
  & npx prisma db push --skip-generate 2>&1 | ForEach-Object { Write-Host "  $_" }
}

# ── Step 4: Generate Prisma client ───────────────────────────────────────────
Write-Host ""
Write-Host "==> Step 4: Generating Prisma client" -ForegroundColor Yellow
& npx prisma generate 2>&1 | Out-Null
Write-Host "  Prisma client generated" -ForegroundColor Green

# ── Step 5: Build ────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "==> Step 5: Building (pnpm build)" -ForegroundColor Yellow
  
  $previousLocation = Get-Location
  Set-Location $ProjectRoot
  & pnpm build 2>&1 | ForEach-Object { Write-Host "  $_" }
  Set-Location $previousLocation
  
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Build failed!" -ForegroundColor Red
    exit 1
  }
  Write-Host "  Build complete" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "==> Step 5: Skipping build (-SkipBuild)" -ForegroundColor Yellow
}

# ── Step 6: Start ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Step 6: Starting services" -ForegroundColor Yellow

$previousLocation = Get-Location
Set-Location $ProjectRoot
& pnpm start --no-build 2>&1 | ForEach-Object { Write-Host "  $_" }
Set-Location $previousLocation

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Deployment Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  DB Backup: $backupFile" -ForegroundColor White
Write-Host ""
Write-Host "  If anything goes wrong, restore with:" -ForegroundColor Yellow
Write-Host "    Copy-Item '$backupFile' '$dbPath' -Force" -ForegroundColor White
Write-Host ""

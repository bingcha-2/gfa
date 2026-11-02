param(
  [string]$InstallRoot = "C:\GFA",
  [string]$RuntimeRoot = "C:\GFA-runtime",
  [switch]$SkipCaddy
)

$ErrorActionPreference = "Stop"

function Get-PortOwner([int]$Port) {
  try {
    return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1 -ExpandProperty OwningProcess
  } catch {
    return $null
  }
}

function Wait-Http([string]$Url, [int]$TimeoutSeconds = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
    }
    Start-Sleep -Seconds 2
  }
  throw "Health check timed out: $Url"
}

$repoRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$redisExe = Join-Path $repoRoot "artifacts\private-hosting\runtime\redis-server.exe"
$runtimeLogs = Join-Path $RuntimeRoot "logs"
New-Item -ItemType Directory -Path $runtimeLogs -Force | Out-Null

if (-not (Get-PortOwner 6379)) {
  if (-not (Test-Path -LiteralPath $redisExe)) {
    throw "Redis executable is missing: $redisExe"
  }

  Start-Process `
    -FilePath $redisExe `
    -ArgumentList @("--port", "6379", "--save", '""', "--appendonly", "no") `
    -WorkingDirectory (Split-Path -Parent $redisExe) `
    -RedirectStandardOutput (Join-Path $runtimeLogs "redis.out.log") `
    -RedirectStandardError (Join-Path $runtimeLogs "redis.err.log") `
    -WindowStyle Hidden

  $redisDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $redisDeadline -and -not (Get-PortOwner 6379)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Get-PortOwner 6379)) {
    throw "Redis did not start. Check $runtimeLogs"
  }
}

Push-Location $repoRoot
try {
  & pnpm.cmd start:daemon
  if ($LASTEXITCODE -ne 0) {
    throw "GFA start failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

Wait-Http "http://127.0.0.1:3001/api/health"
Wait-Http "http://127.0.0.1:3000/"

if (-not $SkipCaddy) {
  $caddyRoot = Join-Path $RuntimeRoot "caddy"
  $caddyExe = Join-Path $caddyRoot "caddy.exe"
  $caddyfile = Join-Path $caddyRoot "Caddyfile"

  if (-not (Test-Path -LiteralPath $caddyExe)) {
    throw "Caddy executable is missing: $caddyExe"
  }

  if (-not (Get-PortOwner 443)) {
    Push-Location $caddyRoot
    try {
      & $caddyExe start --config $caddyfile
      if ($LASTEXITCODE -ne 0) {
        throw "Caddy start failed with exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  }
}

Write-Host ""
Write-Host "GFA target services are ready." -ForegroundColor Green
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(80, 443, 3000, 3001, 6379, 50325) } |
  Sort-Object LocalPort |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Format-Table -AutoSize

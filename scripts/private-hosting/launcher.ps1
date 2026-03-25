param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "status")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$envFilePath = Join-Path $repoRoot ".env"
$envExamplePath = Join-Path $repoRoot ".env.example"
$runtimeDir = Join-Path $repoRoot "artifacts\private-hosting"
$logsDir = Join-Path $runtimeDir "logs"
$statePath = Join-Path $runtimeDir "state.json"

# Bundled mode: installer ships runtime/node.exe + runtime/redis-server.exe
$bundledRuntimeDir  = Join-Path $repoRoot "runtime"
$bundledNodeExe     = Join-Path $bundledRuntimeDir "node.exe"
$bundledRedisExe    = Join-Path $bundledRuntimeDir "redis-server.exe"
$isBundledMode      = (Test-Path $bundledNodeExe) -and (Test-Path $bundledRedisExe)
$wizardScript       = Join-Path $scriptDir "setup-wizard.ps1"
$redisStatePath     = Join-Path $runtimeDir "redis-state.json"
$dataDir            = Join-Path $repoRoot "data"
$dbPath             = Join-Path $dataDir "gfa.db"

function Write-Section([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Initialize-Directory([string]$Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Get-RequiredCommand([string[]]$Names, [string]$Hint) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($command) {
      return $command.Source
    }
  }

  throw $Hint
}

function Read-DotEnv([string]$Path) {
  $result = @{}

  if (-not (Test-Path $Path)) {
    return $result
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()

    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")

    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()

    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $result[$key] = $value
  }

  return $result
}

function Get-Setting([hashtable]$Settings, [string]$Key, [string]$DefaultValue) {
  if ($Settings.ContainsKey($Key) -and $Settings[$Key]) {
    return [string]$Settings[$Key]
  }

  return $DefaultValue
}

function Merge-Maps([hashtable]$Base, [hashtable]$Overrides) {
  $merged = @{}

  foreach ($entry in $Base.GetEnumerator()) {
    $merged[$entry.Key] = [string]$entry.Value
  }

  foreach ($entry in $Overrides.GetEnumerator()) {
    $merged[$entry.Key] = [string]$entry.Value
  }

  return $merged
}

function Use-EnvironmentOverrides([hashtable]$Overrides, [scriptblock]$Script) {
  $previousValues = @{}

  foreach ($entry in $Overrides.GetEnumerator()) {
    $previousValues[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
  }

  try {
    return & $Script
  } finally {
    foreach ($entry in $previousValues.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
  }
}

function Invoke-External(
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [hashtable]$EnvironmentOverrides
) {
  $previousLocation = Get-Location

  try {
    Set-Location $WorkingDirectory
    Write-Host ("PS> {0} {1}" -f (Split-Path $FilePath -Leaf), ($Arguments -join " "))

    Use-EnvironmentOverrides $EnvironmentOverrides {
      & $FilePath @Arguments
      $exitCode = $LASTEXITCODE

      if ($exitCode -ne 0) {
        throw "Command failed with exit code $exitCode."
      }
    }
  } finally {
    Set-Location $previousLocation
  }
}

function Start-ManagedProcess(
  [string]$Name,
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [hashtable]$EnvironmentOverrides,
  [string]$StdOutPath,
  [string]$StdErrPath
) {
  if (Test-Path $StdOutPath) {
    Remove-Item $StdOutPath -Force
  }

  if (Test-Path $StdErrPath) {
    Remove-Item $StdErrPath -Force
  }

  $process = Use-EnvironmentOverrides $EnvironmentOverrides {
    Start-Process `
      -FilePath $FilePath `
      -ArgumentList $Arguments `
      -WorkingDirectory $WorkingDirectory `
      -RedirectStandardOutput $StdOutPath `
      -RedirectStandardError $StdErrPath `
      -WindowStyle Hidden `
      -PassThru
  }

  Start-Sleep -Seconds 1

  if ($process.HasExited) {
    $stderr = if (Test-Path $StdErrPath) { Get-Content -Raw $StdErrPath } else { "" }
    throw "$Name exited immediately. $stderr"
  }

  return $process
}

function Read-State {
  if (-not (Test-Path $statePath)) {
    return $null
  }

  try {
    return Get-Content -Raw $statePath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-State([hashtable]$State) {
  Initialize-Directory $runtimeDir
  $State | ConvertTo-Json -Depth 6 | Set-Content -Path $statePath -Encoding utf8
}

function Clear-State {
  if (Test-Path $statePath) {
    Remove-Item $statePath -Force
  }
}

function Test-ProcessRunning([int]$ProcessIdValue) {
  if ($ProcessIdValue -le 0) {
    return $false
  }

  try {
    $null = Get-Process -Id $ProcessIdValue -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Test-HttpEndpoint([string]$Url, [int]$TimeoutSeconds = 5) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-HttpEndpoint([string]$Name, [string]$Url, [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Url) {
      return
    }

    Start-Sleep -Seconds 2
  }

  throw "$Name did not become ready in time. Check logs under $logsDir."
}

function Get-PortOwner([int]$Port) {
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1

    if ($connection) {
      return [int]$connection.OwningProcess
    }
  } catch {
  }

  return $null
}

function Assert-PortAvailable([int]$Port, [int[]]$AllowedPids = @()) {
  $owner = Get-PortOwner $Port

  if (-not $owner) {
    return
  }

  if ($AllowedPids -contains $owner) {
    return
  }

  throw "Port $Port is already in use by PID $owner."
}

function Test-TcpEndpoint([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 2000) {
  $client = New-Object System.Net.Sockets.TcpClient

  try {
    $asyncResult = $client.BeginConnect($TargetHost, $Port, $null, $null)

    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }

    $client.EndConnect($asyncResult)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-DiscoveredServiceProcessIds($Service) {
  $allNodeProcesses = Get-CimInstance Win32_Process | Where-Object Name -eq "node.exe"

  switch ($Service.name) {
    "api" {
      return $allNodeProcesses |
        Where-Object { $_.CommandLine -like "*dist/main.js*" } |
        Select-Object -ExpandProperty ProcessId
    }
    "worker" {
      return $allNodeProcesses |
        Where-Object { $_.CommandLine -like "*dist/index.js*" } |
        Select-Object -ExpandProperty ProcessId
    }
    "web" {
      if ($service.port) {
        return $allNodeProcesses |
          Where-Object { $_.CommandLine -like "*next start -p $($service.port)*" } |
          Select-Object -ExpandProperty ProcessId
      }

      return $allNodeProcesses |
        Where-Object { $_.CommandLine -like "*next start*" } |
          Select-Object -ExpandProperty ProcessId
    }
    default {
      return @()
    }
  }
}

function Get-RedisEndpoint([hashtable]$EnvironmentContext) {
  $redisUri = [Uri](Get-Setting $EnvironmentContext.Map "REDIS_URL" "redis://localhost:6379")

  return @{
    Url = $redisUri.ToString()
    Host = $redisUri.Host
    Port = $redisUri.Port
  }
}

function Initialize-EnvFile {
  if (-not $isBundledMode) {
    # Dev mode: copy example if missing
    if (Test-Path $envFilePath) { return }
    if (-not (Test-Path $envExamplePath)) {
      throw "Missing .env.example. Cannot create the initial .env file."
    }
    Copy-Item $envExamplePath $envFilePath
    Write-Host "Created .env from .env.example"
    return
  }

  # Bundled mode: run setup wizard when .env is missing or API key is blank
  $needsSetup = $false
  if (-not (Test-Path $envFilePath)) {
    $needsSetup = $true
  } else {
    $parsed = Read-DotEnv $envFilePath
    if ($parsed.ContainsKey("ADSPOWER_API_KEY") -and $parsed["ADSPOWER_API_KEY"]) {
      $needsSetup = $false
    } else {
      $needsSetup = $true
    }
  }

  if ($needsSetup) {
    Write-Host "First-run setup: launching configuration wizard..." -ForegroundColor Cyan
    $wizardArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wizardScript, "-EnvFilePath", $envFilePath)
    $wiz = Start-Process powershell.exe -ArgumentList $wizardArgs -Wait -PassThru -WindowStyle Normal
    if ($wiz.ExitCode -ne 0) {
      throw "Setup wizard was cancelled or failed. Cannot start without configuration."
    }
  }
}

function Initialize-DataDirectory {
  if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }
}

function Get-BaseEnvironment([hashtable]$DotEnv) {
  $webPort = Get-Setting $DotEnv "WEB_PORT" "3000"
  $apiPort = Get-Setting $DotEnv "API_PORT" "3001"
  $apiBaseUrl = Get-Setting $DotEnv "API_BASE_URL" "http://127.0.0.1:$apiPort/api"

  $base = Merge-Maps $DotEnv @{
    WEB_PORT = $webPort
    API_PORT = $apiPort
    API_BASE_URL = $apiBaseUrl
    REDIS_URL = (Get-Setting $DotEnv "REDIS_URL" "redis://localhost:6379")
    DATABASE_URL = (Get-Setting $DotEnv "DATABASE_URL" "file:./dev.db")
    ADSPOWER_HOST = (Get-Setting $DotEnv "ADSPOWER_HOST" "http://127.0.0.1:50325")
    ADSPOWER_API_KEY = (Get-Setting $DotEnv "ADSPOWER_API_KEY" "")
    NEXT_PUBLIC_API_BASE_URL = $apiBaseUrl
    NODE_ENV = "production"
    NEXT_TELEMETRY_DISABLED = "1"
  }

  return @{
    Map = $base
    WebPort = [int]$webPort
    ApiPort = [int]$apiPort
    ApiBaseUrl = $apiBaseUrl
  }
}

function Get-ServiceDefinitions([hashtable]$EnvironmentContext, [string]$NodeExe) {
  $envMap    = $EnvironmentContext.Map
  $apiPort   = $EnvironmentContext.ApiPort
  $webPort   = $EnvironmentContext.WebPort
  $nextCli   = Join-Path $repoRoot "apps\web\node_modules\next\dist\bin\next"

  # Standalone mode: next build output=standalone emits server.js directly in apps/web/
  $standaloneServer = Join-Path $repoRoot "apps\web\server.js"
  $useStandalone    = $isBundledMode -and [System.IO.File]::Exists($standaloneServer)

  $webArgs = @()
  if ($useStandalone) {
    $webArgs = @("server.js")
  } else {
    $webArgs = @($nextCli, "start", "-p", [string]$webPort)
  }

  $apiDef = @{
    Name             = "api"
    FilePath         = $NodeExe
    Arguments        = @("dist/main.js")
    WorkingDirectory = (Join-Path $repoRoot "apps\api")
    Environment      = $envMap
    HealthUrl        = "http://127.0.0.1:$apiPort/api/health"
    Port             = $apiPort
    StdOutPath       = (Join-Path $logsDir "api.out.log")
    StdErrPath       = (Join-Path $logsDir "api.err.log")
  }

  $workerDef = @{
    Name             = "worker"
    FilePath         = $NodeExe
    Arguments        = @("dist/index.js")
    WorkingDirectory = (Join-Path $repoRoot "apps\worker")
    Environment      = $envMap
    HealthUrl        = $null
    Port             = $null
    StdOutPath       = (Join-Path $logsDir "worker.out.log")
    StdErrPath       = (Join-Path $logsDir "worker.err.log")
  }

  $webDef = @{
    Name             = "web"
    FilePath         = $NodeExe
    Arguments        = $webArgs
    WorkingDirectory = (Join-Path $repoRoot "apps\web")
    Environment      = Merge-Maps $envMap @{ PORT = [string]$webPort; HOSTNAME = "0.0.0.0" }
    HealthUrl        = "http://127.0.0.1:$webPort/"
    Port             = $webPort
    StdOutPath       = (Join-Path $logsDir "web.out.log")
    StdErrPath       = (Join-Path $logsDir "web.err.log")
  }

  return @($apiDef, $workerDef, $webDef)
}


function Test-StateHealthy($State) {
  if (-not $State -or -not $State.services) {
    return $false
  }

  foreach ($service in $State.services) {
    if (-not (Test-ProcessRunning ([int]$service.pid))) {
      return $false
    }

    if ($service.healthUrl -and -not (Test-HttpEndpoint $service.healthUrl)) {
      return $false
    }
  }

  return $true
}

function Stop-StateServices($State) {
  if (-not $State -or -not $State.services) {
    return
  }

  foreach ($service in $State.services) {
    $candidateIds = @()
    $knownPid = [int]$service.pid

    if ($knownPid -gt 0) {
      $candidateIds += $knownPid
    }

    $candidateIds += @(Get-DiscoveredServiceProcessIds $service)
    $uniqueIds = $candidateIds | Where-Object { $_ -gt 0 } | Select-Object -Unique

    foreach ($processIdValue in $uniqueIds) {
      if (Test-ProcessRunning $processIdValue) {
        Write-Host "Stopping $($service.name) (PID $processIdValue)"
        Stop-Process -Id $processIdValue -Force
      }
    }
  }
}

function New-ServiceState(
  [string]$Name,
  [int]$ProcessId,
  [Nullable[int]]$Port,
  [string]$HealthUrl,
  [string]$StdOutLog,
  [string]$StdErrLog
) {
  return [pscustomobject]@{
    name = $Name
    pid = $ProcessId
    port = $Port
    healthUrl = $HealthUrl
    stdoutLog = $StdOutLog
    stderrLog = $StdErrLog
  }
}

function Build-Artifacts([string]$PnpmExe, [hashtable]$EnvironmentOverrides) {
  $requiredArtifacts = @(
    (Join-Path $repoRoot "packages\shared\dist\index.js"),
    (Join-Path $repoRoot "apps\api\dist\main.js"),
    (Join-Path $repoRoot "apps\worker\dist\index.js"),
    (Join-Path $repoRoot "apps\web\.next\BUILD_ID")
  )

  $missingArtifacts = $requiredArtifacts | Where-Object { -not (Test-Path $_) }

  if ($missingArtifacts.Count -eq 0) {
    return
  }

  Write-Section "Building production artifacts"
  Invoke-External $PnpmExe @("build") $repoRoot $EnvironmentOverrides
}

function Get-DockerRedisRunning([string]$DockerExe) {
  if (-not $DockerExe) { return $false }
  try {
    $containerNames = & $DockerExe ps --filter "name=gfa-redis" --format "{{.Names}}"
    return ($containerNames | Where-Object { $_ -eq "gfa-redis" }).Count -gt 0
  } catch {
    return $false
  }
}

function Start-BundledRedis([string]$RedisPort) {
  $redisArgs = @("--port", $RedisPort, "--loglevel", "warning", "--save", "")
  $stdOut = Join-Path $logsDir "redis.out.log"
  $stdErr = Join-Path $logsDir "redis.err.log"

  $process = Start-Process `
    -FilePath $bundledRedisExe `
    -ArgumentList $redisArgs `
    -WorkingDirectory $dataDir `
    -RedirectStandardOutput $stdOut `
    -RedirectStandardError $stdErr `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 2
  if ($process.HasExited) {
    $err = if (Test-Path $stdErr) { Get-Content -Raw $stdErr } else { "" }
    throw "Redis failed to start. $err"
  }

  # Persist redis PID for Stop
  @{ pid = $process.Id; port = $RedisPort } | ConvertTo-Json | Set-Content -Path $redisStatePath -Encoding utf8
  return $process
}

function Stop-BundledRedis {
  if (-not (Test-Path $redisStatePath)) { return }
  try {
    $rs = Get-Content -Raw $redisStatePath | ConvertFrom-Json
    $redisPid = [int]$rs.pid
    if ($redisPid -gt 0 -and (Test-ProcessRunning $redisPid)) {
      Write-Host "Stopping bundled Redis (PID $redisPid)"
      Stop-Process -Id $redisPid -Force
    }
  } catch { }
  Remove-Item $redisStatePath -Force -ErrorAction SilentlyContinue
}

function Show-Status([string]$DockerExe, [hashtable]$EnvironmentContext) {
  $state = Read-State
  $adsPowerUri = [Uri](Get-Setting $EnvironmentContext.Map "ADSPOWER_HOST" "http://127.0.0.1:50325")
  $redisEndpoint = Get-RedisEndpoint $EnvironmentContext
  $redisReachable = Test-TcpEndpoint $redisEndpoint.Host $redisEndpoint.Port
  $redisContainerRunning = if ($DockerExe) { Get-DockerRedisRunning $DockerExe } else { $false }

  Write-Section "Private hosting status"
  if ($isBundledMode) {
    Write-Host "[MODE] Bundled (portable runtime)" -ForegroundColor DarkCyan
  }

  if ($state -and $state.services) {
    foreach ($service in $state.services) {
      $knownPid = [int]$service.pid
      $discoveredPids = @(Get-DiscoveredServiceProcessIds $service)
      $activePid = if ($knownPid -gt 0) { $knownPid } elseif ($discoveredPids.Count -gt 0) { [int]$discoveredPids[0] } else { 0 }
      $running = $activePid -gt 0 -and (Test-ProcessRunning $activePid)
      $health = if ($service.healthUrl) { Test-HttpEndpoint $service.healthUrl } else { $running }
      $statusLabel = if ($running -and $health) { "RUNNING" } else { "STOPPED" }
      Write-Host ("[{0}] pid={1} health={2} log={3}" -f $service.name.ToUpper(), $activePid, $statusLabel, $service.stdoutLog)
    }
  } else {
    Write-Host "No launcher state file found."
  }

  $redisStatus = if ($redisReachable) { "REACHABLE" } else { "UNREACHABLE" }
  if ($isBundledMode) {
    Write-Host ("[REDIS] {0} ({1}, bundled)" -f $redisStatus, $redisEndpoint.Url)
  } else {
    $redisMode = if ($redisContainerRunning) { "docker-managed" } else { "external-or-stopped" }
    Write-Host ("[REDIS] {0} ({1}, {2})" -f $redisStatus, $redisEndpoint.Url, $redisMode)
  }

  $adsPowerStatus = if (Test-TcpEndpoint $adsPowerUri.Host $adsPowerUri.Port) { "REACHABLE" } else { "UNREACHABLE" }
  Write-Host ("[ADSPOWER] {0} ({1})" -f $adsPowerStatus, $adsPowerUri)
}

function Start-Launcher {
  Initialize-Directory $runtimeDir
  Initialize-Directory $logsDir

  if ($isBundledMode) {
    Write-Host "[Bundled mode] Using portable runtime: $bundledRuntimeDir" -ForegroundColor Cyan
    $nodeExe = $bundledNodeExe
    $pnpmExe = $null  # Not needed in bundled mode (pre-built)
    $dockerExe = $null
  } else {
    $nodeExe = Get-RequiredCommand @("node.exe", "node") "Node.js is missing. Install Node.js LTS first."
    $pnpmExe = Get-RequiredCommand @("pnpm.cmd", "pnpm") "pnpm is missing. Install pnpm before starting the private host bundle."
    $dockerExe = Get-RequiredCommand @("docker.exe", "docker") "Docker is missing. Install Docker Desktop before starting the private host bundle."
  }

  Write-Section "Preparing environment"
  Initialize-EnvFile

  if ($isBundledMode) {
    Initialize-DataDirectory
  }

  $dotEnv = Read-DotEnv $envFilePath
  $environmentContext = Get-BaseEnvironment $dotEnv
  $services = Get-ServiceDefinitions $environmentContext $nodeExe
  $existingState = Read-State
  $adsPowerUri = [Uri](Get-Setting $environmentContext.Map "ADSPOWER_HOST" "http://127.0.0.1:50325")
  $redisEndpoint = Get-RedisEndpoint $environmentContext
  $redisManagedByLauncher = $false

  if (Test-StateHealthy $existingState) {
    Write-Host "Services are already running."
    Show-Status $dockerExe $environmentContext
    return
  }

  if ($existingState) {
    Stop-StateServices $existingState
    if ($isBundledMode) { Stop-BundledRedis }
    Clear-State
  }

  foreach ($service in $services) {
    if ($service.Port) {
      Assert-PortAvailable $service.Port
    }
  }

  if (-not $isBundledMode -and -not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Section "Installing dependencies"
    Invoke-External $pnpmExe @("install", "--frozen-lockfile") $repoRoot $environmentContext.Map
  }

  if (-not (Test-TcpEndpoint $adsPowerUri.Host $adsPowerUri.Port)) {
    Write-Host "AdsPower Local API is not reachable. Web/API can start, but worker tasks will fail until AdsPower is online." -ForegroundColor Yellow
  }

  # Start Redis
  if (Test-TcpEndpoint $redisEndpoint.Host $redisEndpoint.Port) {
    Write-Host ("Redis already reachable at {0}." -f $redisEndpoint.Url)
  } elseif ($isBundledMode) {
    Write-Section "Starting bundled Redis"
    Start-BundledRedis $redisEndpoint.Port | Out-Null
    Start-Sleep -Seconds 1
    if (-not (Test-TcpEndpoint $redisEndpoint.Host $redisEndpoint.Port)) {
      throw "Bundled Redis did not become reachable. Check logs: $logsDir"
    }
    $redisManagedByLauncher = $true
  } else {
    Write-Section "Starting Redis"
    Invoke-External $dockerExe @("compose", "up", "-d", "redis") $repoRoot $environmentContext.Map
    if (-not (Test-TcpEndpoint $redisEndpoint.Host $redisEndpoint.Port)) {
      throw "Redis did not become reachable after docker compose up."
    }
    $redisManagedByLauncher = $true
  }

  # Sync database
  Write-Section "Syncing database"
  if ($isBundledMode) {
    # Bundled mode: use scripts that don't depend on pnpm
    $dbEnvOverride = Merge-Maps $environmentContext.Map @{ DATABASE_URL = "file:$dbPath" }
    Invoke-External $nodeExe @("scripts/init-sqlite-bundled.mjs") $repoRoot $dbEnvOverride
    Invoke-External $nodeExe @("scripts/seed-bundled.mjs") $repoRoot $dbEnvOverride
    # Patch env context for services (absolute db path)
    $environmentContext.Map["DATABASE_URL"] = "file:$dbPath"
  } else {
    Invoke-External $pnpmExe @("db:init:sqlite") $repoRoot $environmentContext.Map
    Invoke-External $pnpmExe @("db:seed") $repoRoot $environmentContext.Map
  }

  if (-not $isBundledMode) {
    Build-Artifacts $pnpmExe $environmentContext.Map
  }

  $startedServices = @()

  try {
    Write-Section "Starting API"
    $apiDefinition = $services | Where-Object { $_.Name -eq "api" } | Select-Object -First 1
    $apiProcess = Start-ManagedProcess `
      $apiDefinition.Name `
      $apiDefinition.FilePath `
      $apiDefinition.Arguments `
      $apiDefinition.WorkingDirectory `
      $apiDefinition.Environment `
      $apiDefinition.StdOutPath `
      $apiDefinition.StdErrPath
    Wait-HttpEndpoint "API" $apiDefinition.HealthUrl
    $startedServices += New-ServiceState `
      $apiDefinition.Name `
      $apiProcess.Id `
      $apiDefinition.Port `
      $apiDefinition.HealthUrl `
      $apiDefinition.StdOutPath `
      $apiDefinition.StdErrPath

    Write-Section "Starting Worker"
    $workerDefinition = $services | Where-Object { $_.Name -eq "worker" } | Select-Object -First 1
    $workerProcess = Start-ManagedProcess `
      $workerDefinition.Name `
      $workerDefinition.FilePath `
      $workerDefinition.Arguments `
      $workerDefinition.WorkingDirectory `
      $workerDefinition.Environment `
      $workerDefinition.StdOutPath `
      $workerDefinition.StdErrPath

    $startedServices += New-ServiceState `
      $workerDefinition.Name `
      $workerProcess.Id `
      $null `
      $null `
      $workerDefinition.StdOutPath `
      $workerDefinition.StdErrPath

    Write-Section "Starting Web"
    $webDefinition = $services | Where-Object { $_.Name -eq "web" } | Select-Object -First 1
    $webProcess = Start-ManagedProcess `
      $webDefinition.Name `
      $webDefinition.FilePath `
      $webDefinition.Arguments `
      $webDefinition.WorkingDirectory `
      $webDefinition.Environment `
      $webDefinition.StdOutPath `
      $webDefinition.StdErrPath
    Wait-HttpEndpoint "Web" $webDefinition.HealthUrl
    $startedServices += New-ServiceState `
      $webDefinition.Name `
      $webProcess.Id `
      $webDefinition.Port `
      $webDefinition.HealthUrl `
      $webDefinition.StdOutPath `
      $webDefinition.StdErrPath
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Stop-StateServices @{ services = $startedServices }
    throw
  }

  Write-State @{
    startedAt = (Get-Date).ToString("o")
    repoRoot = $repoRoot
    redisManagedByLauncher = $redisManagedByLauncher
    redisUrl = $redisEndpoint.Url
    services = $startedServices
  }

  Write-Section "Done"
  Write-Host ("Public portal:  http://localhost:{0}/" -f $environmentContext.WebPort) -ForegroundColor Green
  Write-Host ("Console login:  http://localhost:{0}/console/login" -f $environmentContext.WebPort) -ForegroundColor Green
  Write-Host ("Logs folder:    {0}" -f $logsDir)

  if ($isBundledMode) {
    # Open browser automatically for end users
    Start-Sleep -Seconds 2
    Start-Process ("http://localhost:{0}/" -f $environmentContext.WebPort)
  }
}

function Stop-Launcher {
  $state = Read-State

  Write-Section "Stopping managed services"
  Stop-StateServices $state

  if ($isBundledMode) {
    Stop-BundledRedis
  } elseif ($state -and $state.redisManagedByLauncher) {
    $dockerExe = Get-Command "docker.exe" -ErrorAction SilentlyContinue
    if (-not $dockerExe) { $dockerExe = Get-Command "docker" -ErrorAction SilentlyContinue }
    if ($dockerExe) {
      try {
        Invoke-External $dockerExe.Source @("compose", "stop", "redis") $repoRoot @{}
      } catch {
        Write-Host "Redis stop skipped: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    }
  }

  Clear-State
  Write-Host "Stopped launcher-managed services."
}

switch ($Action) {
  "start" {
    Start-Launcher
  }
  "stop" {
    Stop-Launcher
  }
  "status" {
    $dockerExe = $null
    if (-not $isBundledMode) {
      $cmd = Get-Command "docker.exe" -ErrorAction SilentlyContinue
      if (-not $cmd) { $cmd = Get-Command "docker" -ErrorAction SilentlyContinue }
      if ($cmd) { $dockerExe = $cmd.Source }
    }
    Initialize-EnvFile
    $dotEnv = Read-DotEnv $envFilePath
    $environmentContext = Get-BaseEnvironment $dotEnv
    Show-Status $dockerExe $environmentContext
  }
}


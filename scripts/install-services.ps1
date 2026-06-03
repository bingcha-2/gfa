# ============================================================
# Install GFA services as Windows Scheduled Tasks (auto-start)
# Run as Administrator: powershell -ExecutionPolicy Bypass -File install-services.ps1
# ============================================================

$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Write-Host "ERROR: node not found"; exit 1 }

$CADDY = "C:\Users\Administrator\Desktop\caddy\caddy.exe"
$CADDYFILE = "C:\Users\Administrator\Desktop\caddy\Caddyfile"
$REMOTE_TOKEN_SERVER = "C:\Users\Administrator\Desktop\GFA-per\apps\gfa-extension\bundled-rosetta\remote-token-server\index.js"
$GFA_ROOT = "C:\Users\Administrator\Desktop\GFA-per"

# ── 1. Caddy (reverse proxy) ──
$taskName = "GFA-Caddy"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task: $taskName"
}
$action = New-ScheduledTaskAction -Execute $CADDY -Argument "run --config `"$CADDYFILE`"" -WorkingDirectory (Split-Path $CADDY)
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "GFA Caddy Reverse Proxy"
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] $taskName registered and started"

# ── 2. Remote Token Server ──
$taskName = "GFA-RemoteTokenServer"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task: $taskName"
}
$action = New-ScheduledTaskAction -Execute $NODE -Argument "`"$REMOTE_TOKEN_SERVER`"" -WorkingDirectory $GFA_ROOT
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "GFA Remote Token Server"
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] $taskName registered and started"

# ── 3. GFA Daemon (api + worker + web) ──
$taskName = "GFA-Daemon"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task: $taskName"
}
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
if ($pnpm) {
    $action = New-ScheduledTaskAction -Execute $pnpm -Argument "start:daemon" -WorkingDirectory $GFA_ROOT
} else {
    $action = New-ScheduledTaskAction -Execute $NODE -Argument "scripts/start.mjs --daemon" -WorkingDirectory $GFA_ROOT
}
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "GFA Daemon (API + Worker + Web)"
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] $taskName registered and started"

Write-Host ""
Write-Host "=== All services registered ==="
Write-Host "Management commands:"
Write-Host "  View:    Get-ScheduledTask -TaskName 'GFA-*'"
Write-Host "  Stop:    Stop-ScheduledTask -TaskName 'GFA-Caddy'"
Write-Host "  Start:   Start-ScheduledTask -TaskName 'GFA-Caddy'"
Write-Host "  Remove:  Unregister-ScheduledTask -TaskName 'GFA-Caddy' -Confirm:`$false"

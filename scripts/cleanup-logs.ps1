[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$PruneOldLogs
)

$ErrorActionPreference = 'Stop'
$logsPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\logs'))
if (-not (Test-Path -LiteralPath $logsPath)) { return }
if ((Get-Item -LiteralPath $logsPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing to clean a redirected logs directory.'
}
$failures = @()
$cutoff = (Get-Date).AddDays(-7)
foreach ($file in Get-ChildItem -LiteralPath $logsPath -File) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    try {
        if ($file.Name -eq 'daemon.log' -and $file.Length -gt 100MB) {
            if ($PSCmdlet.ShouldProcess($file.FullName, 'Clear log larger than 100 MB')) {
                # Keep the file and allow the running daemon to keep its append handle.
                $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open,
                    [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
                try { $stream.SetLength(0) } finally { $stream.Dispose() }
                Write-Output 'Cleared daemon.log'
            }
        } elseif ($PruneOldLogs -and $file.Name -match '^(api|server|web|worker)-(\d{4}-\d{2}-\d{2})\.log$') {
            $logDate = [datetime]::ParseExact($Matches[2], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
            if ($logDate -lt $cutoff.Date -and $file.LastWriteTime -lt $cutoff) {
                if ($PSCmdlet.ShouldProcess($file.FullName, 'Delete service log older than seven days')) {
                    Remove-Item -LiteralPath $file.FullName -Force
                    Write-Output "Deleted $($file.Name)"
                }
            }
        }
    } catch { $failures += "$($file.Name): $($_.Exception.Message)" }
}
if ($failures.Count) { throw ($failures -join "`n") }

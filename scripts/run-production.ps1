$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$node = 'D:\GFA-runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Production Node runtime is missing' }
$env:NODE_ENV = 'production'
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
$log = Join-Path $root ('logs\supervisor-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$ErrorActionPreference = 'Continue'
& $node (Join-Path $PSScriptRoot 'start.mjs') --no-build *>> $log
exit $LASTEXITCODE

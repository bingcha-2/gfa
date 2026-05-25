# publish-update.ps1
# 将构建产物复制到 web/public/updates/ 供自动升级下载
# 用法: .\publish-update.ps1

$ErrorActionPreference = "Stop"

$releaseDir = Join-Path $PSScriptRoot "release"
$updatesDir = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "web") "public") "updates"

# 确保目录存在
if (!(Test-Path $updatesDir)) {
    New-Item -ItemType Directory -Path $updatesDir -Force | Out-Null
}

# 清理旧文件
Get-ChildItem $updatesDir -File | Remove-Item -Force

# 复制 latest.yml
$latestYml = Join-Path $releaseDir "latest.yml"
if (!(Test-Path $latestYml)) {
    Write-Error "latest.yml not found in release/. Run 'npm run dist:win' first."
    exit 1
}
Copy-Item $latestYml $updatesDir
Write-Host "[OK] latest.yml" -ForegroundColor Green

# 复制安装包
$exeFiles = Get-ChildItem $releaseDir -Filter "BingchaAI-Setup-*.exe" | Where-Object { $_.Name -notlike "*.blockmap" }
$latestExeName = ""
foreach ($exe in $exeFiles) {
    Copy-Item $exe.FullName $updatesDir
    $sizeMB = [math]::Round($exe.Length / 1MB, 1)
    Write-Host "[OK] $($exe.Name) ($sizeMB MB)" -ForegroundColor Green
    $latestExeName = $exe.Name
}

# 创建固定名副本，供首页下载按钮使用
if ($latestExeName) {
    $latestPath = Join-Path $updatesDir "BingchaAI-Setup-latest.exe"
    Copy-Item (Join-Path $updatesDir $latestExeName) $latestPath
    Write-Host "[OK] BingchaAI-Setup-latest.exe (download link)" -ForegroundColor Cyan
}

# 复制 blockmap（差量更新）
$blockmaps = Get-ChildItem $releaseDir -Filter "*.blockmap"
foreach ($bm in $blockmaps) {
    Copy-Item $bm.FullName $updatesDir
    Write-Host "[OK] $($bm.Name)" -ForegroundColor Green
}

# 显示 latest.yml 内容
Write-Host ""
Write-Host "=== latest.yml ===" -ForegroundColor Cyan
Get-Content (Join-Path $updatesDir "latest.yml")
Write-Host ""
Write-Host "Done! Deploy web app to make updates live." -ForegroundColor Yellow

# Setup Wizard — Google Family Automation
# Runs on first launch when .env is missing or ADSPOWER_API_KEY is unset.

param(
  [string]$EnvFilePath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-ExistingValue([hashtable]$Settings, [string]$Key, [string]$DefaultValue) {
  if ($Settings.ContainsKey($Key) -and $Settings[$Key]) {
    return [string]$Settings[$Key]
  }

  return $DefaultValue
}

function New-JwtSecret {
  return "gfa-" + [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
}

function Show-SetupForm(
  [string]$CurrentApiKey,
  [string]$CurrentPoolIds,
  [string]$CurrentWebPort,
  [string]$CurrentApiPort
) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Google Family Automation — 首次配置"
  $form.Size = New-Object System.Drawing.Size(520, 430)
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

  # Title label
  $titleLabel = New-Object System.Windows.Forms.Label
  $titleLabel.Text = "Google Family Automation 配置向导"
  $titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
  $titleLabel.Location = New-Object System.Drawing.Point(20, 18)
  $titleLabel.Size = New-Object System.Drawing.Size(440, 30)
  $form.Controls.Add($titleLabel)

  # Subtitle
  $subLabel = New-Object System.Windows.Forms.Label
  $subLabel.Text = "请填写以下信息完成初始化配置："
  $subLabel.ForeColor = [System.Drawing.Color]::Gray
  $subLabel.Location = New-Object System.Drawing.Point(20, 52)
  $subLabel.Size = New-Object System.Drawing.Size(440, 22)
  $form.Controls.Add($subLabel)

  # Separator
  $sep = New-Object System.Windows.Forms.Label
  $sep.BorderStyle = "Fixed3D"
  $sep.Location = New-Object System.Drawing.Point(20, 78)
  $sep.Size = New-Object System.Drawing.Size(430, 2)
  $form.Controls.Add($sep)

  # AdsPower API Key
  $keyLabel = New-Object System.Windows.Forms.Label
  $keyLabel.Text = "AdsPower API Key *"
  $keyLabel.Location = New-Object System.Drawing.Point(20, 96)
  $keyLabel.Size = New-Object System.Drawing.Size(200, 22)
  $keyLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($keyLabel)

  $keyHint = New-Object System.Windows.Forms.Label
  $keyHint.Text = "在 AdsPower → 设置 → API → 本地 API → 找到 API Key"
  $keyHint.ForeColor = [System.Drawing.Color]::Gray
  $keyHint.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
  $keyHint.Location = New-Object System.Drawing.Point(20, 118)
  $keyHint.Size = New-Object System.Drawing.Size(430, 18)
  $form.Controls.Add($keyHint)

  $keyBox = New-Object System.Windows.Forms.TextBox
  $keyBox.Location = New-Object System.Drawing.Point(20, 140)
  $keyBox.Size = New-Object System.Drawing.Size(430, 28)
  $keyBox.Text = $CurrentApiKey
  $keyBox.PlaceholderText = "例如：your-adspower-api-key"
  $form.Controls.Add($keyBox)

  # AdsPower profile pool IDs
  $poolLabel = New-Object System.Windows.Forms.Label
  $poolLabel.Text = "AdsPower 浏览器池 ID *"
  $poolLabel.Location = New-Object System.Drawing.Point(20, 178)
  $poolLabel.Size = New-Object System.Drawing.Size(220, 22)
  $poolLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($poolLabel)

  $poolHint = New-Object System.Windows.Forms.Label
  $poolHint.Text = "填逗号分隔的 profile ID，例如：abc123,def456"
  $poolHint.ForeColor = [System.Drawing.Color]::Gray
  $poolHint.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
  $poolHint.Location = New-Object System.Drawing.Point(20, 200)
  $poolHint.Size = New-Object System.Drawing.Size(470, 18)
  $form.Controls.Add($poolHint)

  $poolBox = New-Object System.Windows.Forms.TextBox
  $poolBox.Location = New-Object System.Drawing.Point(20, 222)
  $poolBox.Size = New-Object System.Drawing.Size(470, 28)
  $poolBox.Text = $CurrentPoolIds
  $poolBox.PlaceholderText = "profile-id-1,profile-id-2"
  $form.Controls.Add($poolBox)

  # Web Port
  $webPortLabel = New-Object System.Windows.Forms.Label
  $webPortLabel.Text = "Web 控制台端口（默认 3000）"
  $webPortLabel.Location = New-Object System.Drawing.Point(20, 272)
  $webPortLabel.Size = New-Object System.Drawing.Size(430, 22)
  $form.Controls.Add($webPortLabel)

  $webPortBox = New-Object System.Windows.Forms.TextBox
  $webPortBox.Location = New-Object System.Drawing.Point(20, 296)
  $webPortBox.Size = New-Object System.Drawing.Size(120, 28)
  $webPortBox.Text = if ($CurrentWebPort) { $CurrentWebPort } else { "3000" }
  $form.Controls.Add($webPortBox)

  # API Port
  $apiPortLabel = New-Object System.Windows.Forms.Label
  $apiPortLabel.Text = "API 端口（默认 3001）"
  $apiPortLabel.Location = New-Object System.Drawing.Point(170, 272)
  $apiPortLabel.Size = New-Object System.Drawing.Size(200, 22)
  $form.Controls.Add($apiPortLabel)

  $apiPortBox = New-Object System.Windows.Forms.TextBox
  $apiPortBox.Location = New-Object System.Drawing.Point(170, 296)
  $apiPortBox.Size = New-Object System.Drawing.Size(120, 28)
  $apiPortBox.Text = if ($CurrentApiPort) { $CurrentApiPort } else { "3001" }
  $form.Controls.Add($apiPortBox)

  # Error label
  $errorLabel = New-Object System.Windows.Forms.Label
  $errorLabel.ForeColor = [System.Drawing.Color]::Red
  $errorLabel.Location = New-Object System.Drawing.Point(20, 336)
  $errorLabel.Size = New-Object System.Drawing.Size(470, 34)
  $form.Controls.Add($errorLabel)

  # OK Button
  $okButton = New-Object System.Windows.Forms.Button
  $okButton.Text = "确认并启动"
  $okButton.Location = New-Object System.Drawing.Point(350, 372)
  $okButton.Size = New-Object System.Drawing.Size(140, 36)
  $okButton.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
  $okButton.ForeColor = [System.Drawing.Color]::White
  $okButton.FlatStyle = "Flat"
  $okButton.FlatAppearance.BorderSize = 0
  $okButton.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  $okButton.Cursor = [System.Windows.Forms.Cursors]::Hand
  $form.Controls.Add($okButton)
  $form.AcceptButton = $okButton

  # Cancel Button
  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = "取消"
  $cancelButton.Location = New-Object System.Drawing.Point(260, 372)
  $cancelButton.Size = New-Object System.Drawing.Size(80, 36)
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancelButton)
  $form.CancelButton = $cancelButton

  $result = @{}

  $okButton.Add_Click({
    $apiKey = $keyBox.Text.Trim()
    $poolIds = $poolBox.Text.Trim()
    $webPort = $webPortBox.Text.Trim()
    $apiPort = $apiPortBox.Text.Trim()

    if (-not $apiKey) {
      $errorLabel.Text = "⚠ AdsPower API Key 不能为空。"
      return
    }

    if (-not $poolIds) {
      $errorLabel.Text = "⚠ AdsPower 浏览器池 ID 不能为空。"
      return
    }

    $webPortNum = 0
    $apiPortNum = 0
    if (-not [int]::TryParse($webPort, [ref]$webPortNum) -or $webPortNum -lt 1024 -or $webPortNum -gt 65535) {
      $errorLabel.Text = "⚠ Web 端口无效，请输入 1024-65535 之间的数字。"
      return
    }
    if (-not [int]::TryParse($apiPort, [ref]$apiPortNum) -or $apiPortNum -lt 1024 -or $apiPortNum -gt 65535) {
      $errorLabel.Text = "⚠ API 端口无效，请输入 1024-65535 之间的数字。"
      return
    }
    if ($webPortNum -eq $apiPortNum) {
      $errorLabel.Text = "⚠ Web 端口和 API 端口不能相同。"
      return
    }

    $result["AdsPowerApiKey"] = $apiKey
    $result["AdsPowerPoolIds"] = $poolIds
    $result["WebPort"] = $webPort
    $result["ApiPort"] = $apiPort
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  })

  $dialogResult = $form.ShowDialog()

  if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) {
    return $result
  }

  return $null
}

# --- Main ---

# Read existing .env if present
$existing = @{}
if (Test-Path $EnvFilePath) {
  foreach ($line in Get-Content $EnvFilePath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $sep = $trimmed.IndexOf("=")
    if ($sep -lt 1) { continue }
    $k = $trimmed.Substring(0, $sep).Trim()
    $v = $trimmed.Substring($sep + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $existing[$k] = $v
  }
}

$currentKey = if ($existing.ContainsKey("ADSPOWER_API_KEY")) { $existing["ADSPOWER_API_KEY"] } else { "" }
$currentPoolIds = if ($existing.ContainsKey("ADSPOWER_POOL_IDS")) { $existing["ADSPOWER_POOL_IDS"] } else { "" }
$currentWeb = if ($existing.ContainsKey("WEB_PORT")) { $existing["WEB_PORT"] } else { "3000" }
$currentApi = if ($existing.ContainsKey("API_PORT")) { $existing["API_PORT"] } else { "3001" }

$answers = Show-SetupForm $currentKey $currentPoolIds $currentWeb $currentApi

if (-not $answers) {
  Write-Host "Setup cancelled by user." -ForegroundColor Yellow
  exit 1
}

# Write .env file
$apiUrlBase = "http://127.0.0.1:$($answers.ApiPort)/api"
$corsOrigins = Get-ExistingValue $existing "CORS_ALLOWED_ORIGINS" "http://localhost:$($answers.WebPort),http://127.0.0.1:$($answers.WebPort)"
$adminPrefix = Get-ExistingValue $existing "ADMIN_PATH_PREFIX" "console"
$adminIpAllowlist = Get-ExistingValue $existing "ADMIN_IP_ALLOWLIST" ""
$consoleCookieSecure = Get-ExistingValue $existing "CONSOLE_COOKIE_SECURE" ""
$adsPowerHost = Get-ExistingValue $existing "ADSPOWER_HOST" "http://127.0.0.1:50325"
$workerName = Get-ExistingValue $existing "WORKER_NAME" "worker-1"
$redisUrl = Get-ExistingValue $existing "REDIS_URL" "redis://localhost:6379"
$databaseUrl = Get-ExistingValue $existing "DATABASE_URL" "file:./data/gfa.db"
$jwtSecret = if ($existing.ContainsKey("JWT_SECRET") -and $existing["JWT_SECRET"] -and -not ([string]$existing["JWT_SECRET"]).StartsWith("REPLACE_WITH_")) {
  [string]$existing["JWT_SECRET"]
} else {
  New-JwtSecret
}

$envContent = @"
DATABASE_URL="$databaseUrl"
REDIS_URL="$redisUrl"
API_PORT="$($answers.ApiPort)"
WEB_PORT="$($answers.WebPort)"
WORKER_NAME="$workerName"
API_BASE_URL="$apiUrlBase"
ADSPOWER_HOST="$adsPowerHost"
ADSPOWER_API_KEY="$($answers.AdsPowerApiKey)"
ADSPOWER_POOL_IDS="$($answers.AdsPowerPoolIds)"
CORS_ALLOWED_ORIGINS="$corsOrigins"
ADMIN_PATH_PREFIX="$adminPrefix"
ADMIN_IP_ALLOWLIST="$adminIpAllowlist"
CONSOLE_COOKIE_SECURE="$consoleCookieSecure"
JWT_SECRET="$jwtSecret"
"@

$envContent | Set-Content -Path $EnvFilePath -Encoding utf8
Write-Host "Configuration saved." -ForegroundColor Green
exit 0

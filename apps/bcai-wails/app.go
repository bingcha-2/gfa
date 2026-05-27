package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx            context.Context
	lock           sync.Mutex
	proxyStartedAt time.Time // 代理启动时间，用于 5h 恢复倒计时
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	initLogger()

	Log("=== 冰茶AI Desktop Startup ===")

	// Load or initialize config
	cfg := LoadConfig()
	if cfg.DeviceId == "" {
		cfg.DeviceId = generateUUID()
		_ = SaveConfig(cfg)
		Log("[app] Generated new deviceId: %s", cfg.DeviceId)
	} else {
		Log("[app] Loaded existing deviceId: %s", cfg.DeviceId)
	}

	// Auto-start HTTP proxy and token leaser if account card is configured
	if cfg.AccountCard != "" {
		Log("[app] Auto-starting HTTP proxy and leaser...")
		// 从配置恢复到期时间
		if cfg.CardExpiry != "" {
			leaser := GetLeaser()
			leaser.mu.Lock()
			leaser.cardExpires = cfg.CardExpiry
			leaser.mu.Unlock()
		}
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	} else {
		Log("[app] No account card configured. Waiting for user configuration.")
	}

	// Always start the HTTP proxy server
	err := GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	if err != nil {
		Log("[app] HTTP proxy start failed: %v", err)
	} else {
		Log("[app] HTTP proxy started on 127.0.0.1:%d", cfg.ProxyPort)
		a.proxyStartedAt = time.Now()
	}

	// 预热连接池，提前建立 TLS 连接
	WarmupConnectionPool(cfg.UpstreamProxy)

	// 加载用量统计并启动自动保存
	GetUsageStats().Load()
	GetUsageStats().StartAutoSave()

	// 初始化本地号池
	GetAccountPool().Init()

	// 启动自动更新检查
	GetUpdater().CleanupOldBinary()
	GetUpdater().Start()
}

// GetConfig returns the loaded configuration
func (a *App) GetConfig() Config {
	return LoadConfig()
}

// SaveConfig saves the configuration and restarts proxy/leaser if needed
func (a *App) SaveConfig(cfg Config) error {
	a.lock.Lock()
	defer a.lock.Unlock()

	oldCfg := LoadConfig()
	err := SaveConfig(cfg)
	if err != nil {
		Log("[app] Save config failed: %v", err)
		return err
	}
	Log("[app] Config saved successfully")

	// If crucial settings changed, restart services
	if oldCfg.AccountCard != cfg.AccountCard ||
		oldCfg.UpstreamProxy != cfg.UpstreamProxy ||
		oldCfg.ProxyPort != cfg.ProxyPort {

		Log("[app] Core settings changed. Restarting services...")

		// 换卡时清空所有本地数据
		if oldCfg.AccountCard != cfg.AccountCard {
			Log("[app] Account card changed, clearing all local data...")
			GetLeaser().ResetAll()
			GetUsageStats().Reset()
			p := GetProxy()
			p.mu.Lock()
			p.stats = ProxyStats{}
			p.mu.Unlock()
			ClearInMemoryLogs()
			a.proxyStartedAt = time.Now()
		}

		GetLeaser().StopAutoLease()
		GetHTTPProxy().Stop()

		if cfg.AccountCard != "" {
			GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
		}

		// Restart HTTP proxy
		GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	} else {
		// Just update proxy config without restart
		GetHTTPProxy().UpdateConfig(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	}

	return nil
}

// ActivateCard saves the account card/access key and tests a token lease
func (a *App) ActivateCard(card string) (string, error) {
	cfg := LoadConfig()
	oldCard := cfg.AccountCard
	cfg.AccountCard = card
	_ = SaveConfig(cfg)

	// 换卡时清空所有本地数据
	if oldCard != card {
		Log("[app] Account card changed via ActivateCard, clearing all local data...")
		GetLeaser().ResetAll()
		GetUsageStats().Reset()
		p := GetProxy()
		p.mu.Lock()
		p.stats = ProxyStats{}
		p.mu.Unlock()
		ClearInMemoryLogs()
		a.proxyStartedAt = time.Now()
	}

	// Test lease to verify the card is valid
	lease, err := GetLeaser().LeaseToken(card, cfg.DeviceId, true, nil, cfg.UpstreamProxy)
	if err != nil {
		return "", err
	}

	// Start auto-lease if not already running
	GetLeaser().StartAutoLease(card, cfg.DeviceId, cfg.UpstreamProxy)
	GetHTTPProxy().UpdateConfig(card, cfg.DeviceId, cfg.UpstreamProxy)

	return fmt.Sprintf("Token obtained for account #%d", lease.AccountId), nil
}

// GetStats returns combined proxy and leaser metrics
func (a *App) GetStats() map[string]interface{} {
	proxyStats := GetProxy().GetStats()
	leaserStatus := GetLeaser().GetStatus()
	httpProxyStatus := GetHTTPProxy().GetStatus()
	usageStats := GetUsageStats()

	// 判断图表模式：只有1天有数据时显示小时，否则显示日
	chartMode := "daily"
	if !usageStats.HasMultipleDays() {
		chartMode = "hourly"
	}

	return map[string]interface{}{
		"proxyRunning":     httpProxyStatus.Running,
		"proxyPort":        httpProxyStatus.ListenPort,
		"stats":            proxyStats,
		"leaser":           leaserStatus,
		"httpProxy":        httpProxyStatus,
		"today":            usageStats.GetTodayRecord(),
		"dailyHistory":     usageStats.GetDailyRecords(7),
		"hourlyHistory":    usageStats.GetTodayHourlyRecords(),
		"chartMode":        chartMode,
		"cumulativeSaving": usageStats.GetCumulativeSavings(),
		"appVersion":       AppVersion,
		"updateStatus":     GetUpdater().GetStatus(),
		"poolMode":         LoadConfig().PoolMode,
		"poolStatus":       GetAccountPool().GetPoolStatus(),
		"proxyStartedAt":   a.proxyStartedAt.Format(time.RFC3339),
	}
}

// RestartProxy manually stops and restarts the proxy server and background leaser
func (a *App) RestartProxy() error {
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()
	GetLeaser().StopAutoLease()
	GetHTTPProxy().Stop()

	if cfg.AccountCard != "" {
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	}

	return GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
}

// ======================== IDE 注入相关方法 ========================

// GetIDEStatus 获取 IDE 注入状态
func (a *App) GetIDEStatus() IDEStatus {
	cfg := LoadConfig()
	return DetectIDEProducts(cfg.ProxyPort)
}

// DetectedPaths 返回自动检测到的路径
type DetectedPaths struct {
	IDEPath string `json:"idePath"`
	HubPath string `json:"hubPath"`
}

// GetDetectedPaths 获取自动检测到的 IDE/Hub 安装路径
func (a *App) GetDetectedPaths() DetectedPaths {
	return DetectedPaths{
		IDEPath: detectAntigravityIDEPath(),
		HubPath: detectAntigravityHubPath(),
	}
}

// BrowseForPath 打开系统文件浏览对话框，让用户选择应用程序
func (a *App) BrowseForPath(title string) string {
	result, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                title,
		CanCreateDirectories: false,
		Filters: []runtime.FileFilter{
			{DisplayName: "应用程序", Pattern: "*.app;*.exe"},
			{DisplayName: "所有文件", Pattern: "*"},
		},
	})
	if err != nil {
		return ""
	}
	return result
}

// targets: ["ide", "hub"]
func (a *App) InjectSelected(targets []string) (string, error) {
	cfg := LoadConfig()

	// 校验：remote 模式必须有卡密，local 模式必须有号池账号
	poolMode := cfg.PoolMode
	if poolMode == "" {
		poolMode = "remote"
	}
	if poolMode == "remote" && cfg.AccountCard == "" {
		return "", fmt.Errorf("请先激活账号卡再开启接管")
	}
	if poolMode == "local" {
		poolStatus := GetAccountPool().GetPoolStatus()
		total, _ := poolStatus["total"].(int)
		if total <= 0 {
			return "", fmt.Errorf("本地号池为空，请先添加账号再开启接管")
		}
	}

	var results []string
	restartIDE := false

	for _, t := range targets {
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "ide":
			if err := InjectIDESettings(cfg.ProxyPort); err != nil {
				results = append(results, "Antigravity IDE: 接管失败")
			} else {
				restartIDE = true
			}
		case "hub":
			hubPath := detectAntigravityHubPath()
			if hubPath == "" {
				results = append(results, "Antigravity Hub: 未检测到应用")
				continue
			}
			// Hub 正在运行时 app.asar 会被 Electron 锁定，必须先关闭再 patch
			hubWasRunning := IsHubRunning()
			if hubWasRunning {
				Log("[ide-inject] Hub 正在运行，先关闭以解锁 app.asar...")
				killHubForPatch()
			}
			if err := PatchAsar(cfg.ProxyPort); err != nil {
				Log("[ide-inject] PatchAsar 失败: %v", err)
				results = append(results, fmt.Sprintf("Antigravity Hub: 接管失败 (%v)", err))
				// 如果之前关了 Hub，尝试重新启动（即使 patch 失败也要恢复原状）
				if hubWasRunning {
					_ = LaunchHub()
				}
			} else {
				Log("[ide-inject] PatchAsar 成功")
				// patch 成功后启动 Hub
				if err := LaunchHub(); err != nil {
					Log("[ide-inject] Hub 启动失败: %v", err)
					results = append(results, "Antigravity Hub: ✓ 已接管，但启动失败")
				} else {
					results = append(results, "Antigravity Hub: ✓ 已接管并启动")
				}
			}
		}
	}

	// IDE: 写入 settings.json 后直接完整重启 IDE（与 Timo 策略一致）
	// 只杀 LS 行不通：extension host 会缓存旧端口导致 ECONNREFUSED
	if restartIDE {
		results = append(results, "Antigravity IDE: ✓ 已接管，正在重启 IDE...")
		go func() {
			defer func() {
				if r := recover(); r != nil {
					Log("[ide-inject] IDE 重启 goroutine panic: %v", r)
				}
			}()
			if err := ForceRestartIDE(); err != nil {
				Log("[ide-inject] 完整重启 IDE 失败: %v", err)
			} else {
				Log("[ide-inject] ✓ IDE 已完整重启")
			}
		}()
	}

	msg := strings.Join(results, "\n")
	return msg, nil
}

// RestoreSelected 根据用户选择恢复指定产品，并自动重启
// targets: ["ide", "hub"]
func (a *App) RestoreSelected(targets []string) (string, error) {
	var results []string
	restartIDE := false
	restartHub := false

	for _, t := range targets {
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "ide":
			if err := RestoreIDESettings(); err != nil {
				results = append(results, "Antigravity IDE: 恢复失败")
			} else {
				restartIDE = true
			}
		case "hub":
			if err := RestoreAsar(); err != nil {
				results = append(results, "Antigravity Hub: 恢复失败")
			} else {
				restartHub = true
			}
		}
	}

	// IDE: 恢复后重启 language_server 让它重新读取原始配置
	if restartIDE {
		if IsIDERunning() {
			RestartLanguageServerIfNeeded(0) // port=0 确保不匹配，强制杀 LS
			results = append(results, "Antigravity IDE: ✓ 已恢复（language_server 将自动重启）")
		} else {
			results = append(results, "Antigravity IDE: ✓ 已恢复")
		}
	}

	if restartHub {
		if IsHubRunning() {
			if err := KillAndRestartHub(); err != nil {
				results = append(results, "Antigravity Hub: 重启失败")
			} else {
				results = append(results, "Antigravity Hub: ✓ 已恢复并重启")
			}
		} else {
			results = append(results, "Antigravity Hub: ✓ 已恢复")
		}
	}

	msg := strings.Join(results, "\n")
	return msg, nil
}

// IsIDERunningCheck 检测 IDE 是否正在运行（前端用于提示重启）
func (a *App) IsIDERunningCheck() bool {
	return IsIDERunning()
}

// IsHubRunningCheck 检测 Hub 是否正在运行
func (a *App) IsHubRunningCheck() bool {
	return IsHubRunning()
}

// GetLogs returns the memory log buffer
func (a *App) GetLogs() []string {
	return GetInMemoryLogs()
}

// ClearLogs clears the memory and disk log buffers
func (a *App) ClearLogs() bool {
	ClearInMemoryLogs()
	return true
}

// ClearStats resets the request count and token stats
func (a *App) ClearStats() bool {
	p := GetProxy()
	p.mu.Lock()
	p.stats = ProxyStats{}
	p.mu.Unlock()
	Log("[app] Stats cleared")
	return true
}

// helper to generate random pseudo-UUID
func generateUUID() string {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	if err != nil {
		return "device-fallback-uuid"
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ======================== 自动更新方法 ========================

// GetUpdateStatus 获取更新状态（前端轮询）
func (a *App) GetUpdateStatus() UpdateStatus {
	return GetUpdater().GetStatus()
}

// CheckForUpdate 手动检查更新
func (a *App) CheckForUpdate() map[string]interface{} {
	info := GetUpdater().CheckForUpdate()
	if info != nil {
		return map[string]interface{}{
			"available": true,
			"version":   info.Version,
			"changelog": info.Changelog,
			"size":      info.Size,
		}
	}
	status := GetUpdater().GetStatus()
	return map[string]interface{}{
		"available": false,
		"status":    status.Status,
		"error":     status.Error,
		"current":   AppVersion,
	}
}

// DownloadUpdate 下载并安装更新
func (a *App) DownloadUpdate() error {
	return GetUpdater().DownloadAndApply()
}

// RestartToUpdate 重启以应用更新
func (a *App) RestartToUpdate() error {
	return GetUpdater().RestartApp()
}

// GetAppVersion 获取当前版本号
func (a *App) GetAppVersion() string {
	return AppVersion
}

// ======================== 本地号池方法 ========================

// GetPoolAccounts 获取号池账号列表（脱敏）
func (a *App) GetPoolAccounts() []AccountInfo {
	return GetAccountPool().ListAccounts()
}

// GetPoolStatus 获取号池状态概览
func (a *App) GetPoolStatus() map[string]interface{} {
	return GetAccountPool().GetPoolStatus()
}

// AddPoolAccount 添加账号到号池
func (a *App) AddPoolAccount(email, refreshToken, oauthProfile string) map[string]interface{} {
	id, err := GetAccountPool().AddAccount(email, refreshToken, oauthProfile)
	if err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	// 立即尝试刷新 token 验证账号有效性
	go func() {
		_, err := GetAccountPool().GetAccessToken(id)
		if err != nil {
			Log("[account-pool] Warning: token refresh for #%d failed: %v", id, err)
		} else {
			Log("[account-pool] Account #%d token verified OK", id)
		}
	}()
	return map[string]interface{}{"success": true, "id": id}
}

// RemovePoolAccount 从号池删除账号
func (a *App) RemovePoolAccount(id int) map[string]interface{} {
	if err := GetAccountPool().RemoveAccount(id); err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	return map[string]interface{}{"success": true}
}

// TogglePoolAccount 启用/禁用账号
func (a *App) TogglePoolAccount(id int, enabled bool) map[string]interface{} {
	if err := GetAccountPool().ToggleAccount(id, enabled); err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	return map[string]interface{}{"success": true}
}

// SetPoolMode 切换模式: "remote" 或 "local"
func (a *App) SetPoolMode(mode string) map[string]interface{} {
	if mode != "remote" && mode != "local" {
		return map[string]interface{}{"success": false, "error": "无效模式，只能是 remote 或 local"}
	}
	cfg := LoadConfig()
	cfg.PoolMode = mode
	_ = SaveConfig(cfg)
	Log("[app] Pool mode changed to: %s", mode)
	return map[string]interface{}{"success": true, "mode": mode}
}

// GetPoolMode 获取当前模式
func (a *App) GetPoolMode() string {
	cfg := LoadConfig()
	if cfg.PoolMode == "" {
		return "remote"
	}
	return cfg.PoolMode
}

// OAuthLogin starts a Google OAuth login flow and auto-adds the account to the pool
func (a *App) OAuthLogin(profile string) map[string]interface{} {
	result, err := GetAccountPool().StartOAuthLogin(profile, func(url string) {
		runtime.BrowserOpenURL(a.ctx, url)
	})
	if err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}

	// Auto-add to pool
	id, addErr := GetAccountPool().AddAccount(result.Email, result.RefreshToken, profile)
	if addErr != nil {
		return map[string]interface{}{
			"success": false,
			"error":   fmt.Sprintf("OAuth 登录成功 (%s)，但添加到号池失败: %v", result.Email, addErr),
		}
	}

	// Verify token
	go func() {
		_, err := GetAccountPool().GetAccessToken(id)
		if err != nil {
			Log("[oauth] Warning: token refresh for #%d failed: %v", id, err)
		} else {
			Log("[oauth] Account #%d token verified OK", id)
		}
	}()

	return map[string]interface{}{
		"success": true,
		"email":   result.Email,
		"id":      id,
	}
}

// RefreshPoolQuota 刷新所有账号的配额信息
func (a *App) RefreshPoolQuota() map[string]interface{} {
	refreshed := GetAccountPool().RefreshAllQuotas()
	return map[string]interface{}{"success": true, "refreshed": refreshed}
}

// SwitchPoolAccount 手动切换当前活跃账号
func (a *App) SwitchPoolAccount(id int) map[string]interface{} {
	GetAccountPool().SetActiveAccount(id)
	return map[string]interface{}{"success": true}
}

// SetAccountAlias 设置账号别名
func (a *App) SetAccountAlias(id int, alias string) map[string]interface{} {
	if err := GetAccountPool().SetAccountAlias(id, alias); err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	return map[string]interface{}{"success": true}
}

// LockPoolAccount 锁定指定账号（仅使用该账号）
func (a *App) LockPoolAccount(id int) map[string]interface{} {
	if err := GetAccountPool().LockAccount(id); err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	return map[string]interface{}{"success": true}
}

// UnlockPoolAccount 解除账号锁定
func (a *App) UnlockPoolAccount() map[string]interface{} {
	GetAccountPool().UnlockAccount()
	return map[string]interface{}{"success": true}
}

// GetAnnouncement 从服务器获取滚动公告内容
func (a *App) GetAnnouncement() string {
	client := createHttpClient("")
	client.Timeout = 5 * time.Second

	resp, err := client.Get("https://bcai.site/remote-token/announcement")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return ""
	}

	body := make([]byte, 1024) // 公告最多 1KB
	n, _ := resp.Body.Read(body)
	text := strings.TrimSpace(string(body[:n]))
	return text
}

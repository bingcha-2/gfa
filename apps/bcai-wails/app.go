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
	ctx  context.Context
	lock sync.Mutex
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
	cfg.AccountCard = card
	_ = SaveConfig(cfg)

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
	restartHub := false

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
			if err := PatchAsar(cfg.ProxyPort); err != nil {
				results = append(results, "Antigravity Hub: 接管失败")
			} else {
				restartHub = true
			}
		}
	}

	// IDE: 先尝试只重启 language_server（保留登录态）
	// 如果 LS 未能在 8 秒内连接代理，则升级为完整重启 IDE（解决 extension host 端口缓存问题）
	if restartIDE {
		if IsIDERunning() {
			RestartLanguageServerIfNeeded(cfg.ProxyPort)
			// 等待 LS 生效
			lsApplied := false
			for i := 0; i < 8; i++ {
				time.Sleep(1 * time.Second)
				if IsLSProxyApplied(cfg.ProxyPort) {
					lsApplied = true
					break
				}
				Log("[ide-inject] 等待 LS 连接代理... (%d/8)", i+1)
			}
			if lsApplied {
				results = append(results, "Antigravity IDE: ✓ 已接管（LS 已连接代理）")
			} else {
				// LS 未生效 → extension host 可能缓存旧端口，升级为完整重启 IDE
				Log("[ide-inject] LS 未在 8s 内生效，升级为完整重启 IDE")
				if err := ForceRestartIDE(); err != nil {
					results = append(results, "Antigravity IDE: ✓ 已接管，但自动重启失败，请手动重启 IDE")
				} else {
					results = append(results, "Antigravity IDE: ✓ 已接管并重启 IDE")
				}
			}
		} else {
			if err := LaunchIDE(); err != nil {
				results = append(results, "Antigravity IDE: ✓ 已接管，启动失败")
			} else {
				results = append(results, "Antigravity IDE: ✓ 已接管并启动")
			}
		}
	}

	if restartHub {
		if IsHubRunning() {
			if err := KillAndRestartHub(); err != nil {
				results = append(results, "Antigravity Hub: 重启失败")
			} else {
				results = append(results, "Antigravity Hub: ✓ 已接管并重启")
			}
		} else {
			if err := LaunchHub(); err != nil {
				results = append(results, "Antigravity Hub: ✓ 已接管，启动失败")
			} else {
				results = append(results, "Antigravity Hub: ✓ 已接管并启动")
			}
		}
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

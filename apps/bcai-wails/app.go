package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"os/exec"
	goruntime "runtime"
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
		// 先 Activate 拿到权威 products(开通了哪些产品),StartAutoLease 据此决定是否跑
		// antigravity 自动租号 —— 避免 codex-only 卡在启动时盲发 antigravity 租号并报错。
		// Activate 失败(网络等)不阻塞:StartAutoLease 仍会尝试(池子卡语义)。
		if _, err := GetLeaser().Activate(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy); err != nil {
			Log("[app] 启动时 Activate 失败(不阻塞自动租号): %v", err)
		}
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
	} else {
		Log("[app] No account card configured. Waiting for user configuration.")
	}

	// 清理旧版接管残留的本地 chatgpt_base_url(新版用自定义 provider;旧残留会让
	// Codex 把杂活继续发到本地代理被吞)。只清本地 127.0.0.1 残留,无残留则 no-op。
	if err := CleanupLegacyCodexTakeover(); err != nil {
		Log("[codex] 清理旧版接管残留失败(不致命): %v", err)
	}

	// 应用 Codex 中转(API 卡密)模式配置(若未配置 relay 则为 no-op,走号池/租号)。
	GetCodexProxy().ApplyConfig(cfg)

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

	// 应用 Codex 中转(API 卡密)模式配置:只改请求处理、不动监听,无需重启代理。
	GetCodexProxy().ApplyConfig(cfg)

	// If crucial settings changed, restart services
	if oldCfg.AccountCard != cfg.AccountCard ||
		oldCfg.UpstreamProxy != cfg.UpstreamProxy ||
		oldCfg.ProxyPort != cfg.ProxyPort {

		Log("[app] Core settings changed. Restarting services...")

		// 换卡时清空本地统计数据 + 旧卡的 products(accessKeyStatus),避免用旧卡产品
		// 误判新卡是否开通 antigravity;新卡 products 由下面的 Activate 重新写入。
		if oldCfg.AccountCard != cfg.AccountCard {
			Log("[app] Account card changed: clearing local stats")
			GetUsageStats().Reset()
			GetLeaser().ResetLocalQuota()
			GetLeaser().ClearAccessKeyStatus()
		}

		GetLeaser().StopAutoLease()
		GetHTTPProxy().Stop()

		if cfg.AccountCard != "" {
			// 重新 Activate 拿到(可能换了卡的)权威 products,再让 StartAutoLease 按产品决定
			// 是否跑 antigravity 自动租号,避免沿用旧卡 products 误判。
			if _, err := GetLeaser().Activate(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy); err != nil {
				Log("[app] 重启时 Activate 失败(不阻塞自动租号): %v", err)
			}
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

// ActivateCard saves the account card/access key and validates it server-side.
func (a *App) ActivateCard(card string) (string, error) {
	cfg := LoadConfig()
	cfg.AccountCard = card
	_ = SaveConfig(cfg)

	// Activation = card validation only (/api/activate). Whether a token can be
	// leased right now (account-pool availability) is a runtime concern, not an
	// activation failure — a momentarily dry pool must not block activation.
	expiresAt, err := GetLeaser().Activate(card, cfg.DeviceId, cfg.UpstreamProxy)
	if err != nil {
		return "", err
	}

	// Start auto-lease / proxy so the client is ready to serve requests.
	GetLeaser().StartAutoLease(card, cfg.DeviceId, cfg.UpstreamProxy)
	GetHTTPProxy().UpdateConfig(card, cfg.DeviceId, cfg.UpstreamProxy)

	// Best-effort warm probe — never fatal. If the pool is momentarily dry the
	// card is still activated; the user just sees a "busy" hint at request time.
	// 只为开通了 antigravity 的卡(或池子卡)预热 —— codex-only 卡预热 antigravity 无意义,
	// 且会把"此卡未开通该服务"写进 lastError、弹给前端。
	if GetLeaser().coversAntigravity() {
		if _, leaseErr := GetLeaser().LeaseToken(card, cfg.DeviceId, true, nil, cfg.UpstreamProxy); leaseErr != nil {
			Log("[activate] card activated but warm lease failed (non-fatal): %v", leaseErr)
		}
	}

	return expiresAt, nil
}

// GetStats returns combined proxy and leaser metrics
func (a *App) GetStats() map[string]interface{} {
	proxyStats := GetProxy().GetStats()
	leaserStatus := GetLeaser().GetStatus()
	// 绑定号各 bucket 的真实上游剩余分数 + 各自恢复倒计时(跨两个 leaser 汇总)。
	leaserStatus["bucketFractions"] = snapshotBoundFractions()
	leaserStatus["bucketResetMs"] = snapshotBoundResets(time.Now().UnixMilli())
	// Codex / Anthropic 都是账号级双窗口(5h + 周),像后台一样分两条显示。
	if cq := codexQuotaStatus(GetCodexLeaser().LatestCodexQuota(), time.Now().UnixMilli()); cq != nil {
		leaserStatus["codexQuota"] = cq
	}
	if cq := claudeQuotaStatus(GetClaudeLeaser().LatestClaudeQuota(), time.Now().UnixMilli()); cq != nil {
		leaserStatus["claudeQuota"] = cq
	}
	// 绑定卡各产品当前租到的账号信息 + token,供前端「绑定账号信息」面板显示。
	leaserStatus["boundAccounts"] = collectBoundAccounts()
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
		"activeAccount":    GetAccountPool().GetActiveAccountInfo(),
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

	GetCodexProxy().ApplyConfig(cfg) // 重启时重新应用 Codex 中转模式配置
	return GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
}

// ======================== Codex 中转(API 卡密)模式 ========================

// GetCodexRelayConfig 返回当前 Codex 中转配置(供前端设置面板回显)。
func (a *App) GetCodexRelayConfig() map[string]interface{} {
	cfg := LoadConfig()
	mode := cfg.CodexMode
	if mode == "" {
		mode = "rental"
	}
	protocol := cfg.CodexRelayProtocol
	if protocol == "" {
		protocol = "responses"
	}
	return map[string]interface{}{
		"mode":     mode,
		"baseURL":  cfg.CodexRelayBase,
		"apiKey":   cfg.CodexRelayKey,
		"protocol": protocol,
		"modelMap": cfg.CodexModelMap,
	}
}

// SaveCodexRelayConfig 持久化 Codex 中转(API 卡密)模式配置并立即生效(无需重启代理,
// 中转只改请求处理、不动监听)。mode=="relay" 启用中转;其它(含 "" / "rental")回到
// 号池/租号模式。modelMap 可为 nil。前端设置面板调用此方法。
func (a *App) SaveCodexRelayConfig(mode, baseURL, apiKey, protocol string, modelMap map[string]string) error {
	a.lock.Lock()
	defer a.lock.Unlock()

	cfg := LoadConfig()
	cfg.CodexMode = mode
	cfg.CodexRelayBase = baseURL
	cfg.CodexRelayKey = apiKey
	cfg.CodexRelayProtocol = protocol
	cfg.CodexModelMap = modelMap
	if err := SaveConfig(cfg); err != nil {
		Log("[app] 保存 Codex 中转配置失败: %v", err)
		return err
	}
	GetCodexProxy().ApplyConfig(cfg)
	Log("[app] Codex 中转配置已更新: mode=%s proto=%s base=%s", mode, protocol, baseURL)
	return nil
}

// ======================== IDE 注入相关方法 ========================

// GetIDEStatus 获取 IDE 注入状态
func (a *App) GetIDEStatus() IDEStatus {
	cfg := LoadConfig()
	return DetectIDEProducts(cfg.ProxyPort)
}

// DetectedPaths 返回自动检测到的路径
type DetectedPaths struct {
	IDEPath      string `json:"idePath"`
	HubPath      string `json:"hubPath"`
	CodexAppPath string `json:"codexAppPath"`
}

// GetDetectedPaths 获取自动检测到的 IDE/Hub 安装路径
func (a *App) GetDetectedPaths() DetectedPaths {
	return DetectedPaths{
		IDEPath:      detectAntigravityIDEPath(),
		HubPath:      detectAntigravityHubPath(),
		CodexAppPath: detectCodexAppPath(),
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

// InjectSelected 接管指定产品(每个产品独立,可单独调用)。
// targets: 任意 ["ide" | "hub" | "codex"] 子集(也接受产品 id)。
func (a *App) InjectSelected(targets []string) (string, error) {
	cfg := LoadConfig()
	if err := validateTakeoverPrereqs(cfg); err != nil {
		return "", err
	}

	// 绑定卡:只能接管它开通的产品。codex 卡开 antigravity 接管 → 直接拒绝。
	// 池子卡(products 为空)不限制。
	products := GetLeaser().CardProducts()

	var results []string
	for _, raw := range targets {
		t := findTakeoverTarget(strings.ToLower(strings.TrimSpace(raw)))
		if t == nil {
			continue
		}
		if required := targetRequiredProduct(t.ProductID()); !cardCoversProduct(products, required) {
			return "", fmt.Errorf("此卡未开通 %s,无法接管 %s(请使用对应产品的卡密,或改用池子卡)", productLabel(required), t.Name())
		}
		msg, err := t.Inject(cfg.ProxyPort)
		if err != nil {
			results = append(results, fmt.Sprintf("%s: 接管失败 (%v)", t.Name(), err))
		} else if msg != "" {
			results = append(results, msg)
		}
	}
	return strings.Join(results, "\n"), nil
}

// RestoreSelected 还原指定产品(每个产品独立,可单独调用)。
// targets: 任意 ["ide" | "hub" | "codex"] 子集(也接受产品 id)。
func (a *App) RestoreSelected(targets []string) (string, error) {
	var results []string
	for _, raw := range targets {
		t := findTakeoverTarget(strings.ToLower(strings.TrimSpace(raw)))
		if t == nil {
			continue
		}
		msg, err := t.Restore()
		if err != nil {
			results = append(results, fmt.Sprintf("%s: 恢复失败 (%v)", t.Name(), err))
		} else if msg != "" {
			results = append(results, msg)
		}
	}
	return strings.Join(results, "\n"), nil
}

// OpenSystemPermissionSettings 打开系统权限设置页,引导用户授权接管所需权限
// (macOS: App 管理;Windows: 应用设置)。前端在 macOS 提示或接管失败时调用。
func (a *App) OpenSystemPermissionSettings() error {
	switch goruntime.GOOS {
	case "darwin":
		// 隐私与安全性 → App 管理
		return exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles").Start()
	case "windows":
		return exec.Command("cmd", "/c", "start", "", "ms-settings:appsfeatures").Start()
	default:
		return nil
	}
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
func (a *App) AddPoolAccount(email, refreshToken string) map[string]interface{} {
	id, err := GetAccountPool().AddAccount(email, refreshToken)
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
func (a *App) OAuthLogin() map[string]interface{} {
	result, err := GetAccountPool().StartOAuthLogin(func(url string) {
		runtime.BrowserOpenURL(a.ctx, url)
	})
	if err != nil {
		return map[string]interface{}{"success": false, "error": err.Error()}
	}

	// Auto-add to pool
	id, addErr := GetAccountPool().AddAccount(result.Email, result.RefreshToken)
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

	// 依次尝试主域名 → 备域名（bcai_hosts.go）
	for _, rawURL := range bcaiURLCandidates(API_BASE + "/announcement") {
		resp, err := client.Get(rawURL)
		if err != nil {
			continue // 该域名不可达，尝试下一个
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			continue
		}
		body := make([]byte, 1024) // 公告最多 1KB
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		return strings.TrimSpace(string(body[:n]))
	}
	return ""
}

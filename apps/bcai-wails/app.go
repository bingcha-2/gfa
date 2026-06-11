package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
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

	// Auto-start services if user is logged in (has a session token)
	if cfg.UserToken != "" {
		Log("[app] User logged in, auto-starting services...")
		startServicesForUser(cfg)
	} else {
		Log("[app] No user session. Waiting for user to log in.")
	}

	// 清理旧版接管残留的本地 chatgpt_base_url(新版用自定义 provider;旧残留会让
	// Codex 把杂活继续发到本地代理被吞)。只清本地 127.0.0.1 残留,无残留则 no-op。
	if err := CleanupLegacyCodexTakeover(); err != nil {
		Log("[codex] 清理旧版接管残留失败(不致命): %v", err)
	}

	// 应用 Codex 中转(API 卡密)模式配置(若未配置 relay 则为 no-op,走号池/租号)。
	GetCodexProxy().ApplyConfig(cfg)

	// Record proxy start time (startServicesForUser starts it if logged in)
	a.proxyStartedAt = time.Now()

	// 预热连接池，提前建立 TLS 连接
	WarmupConnectionPool("")

	// 加载用量统计并启动自动保存
	GetUsageStats().Load()
	GetUsageStats().StartAutoSave()

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
	if oldCfg.UserToken != cfg.UserToken ||
		oldCfg.ProxyPort != cfg.ProxyPort {

		Log("[app] Core settings changed. Restarting services...")

		// Token changed: clear stale local state
		if oldCfg.UserToken != cfg.UserToken {
			clearLocalCardState()
		}

		GetLeaser().StopAutoLease()
		GetHTTPProxy().Stop()

		if cfg.UserToken != "" {
			startServicesForUser(cfg)
		}
	} else {
		// Just update proxy config without restart
		GetHTTPProxy().UpdateConfig(cfg.UserToken, cfg.DeviceId, "")
	}

	// MITM 代理端口固定,无需重启,只同步 token/出口(覆盖上面两个分支)。
	GetMitmManager().UpdateConfig(cfg.UserToken, cfg.DeviceId, "")

	return nil
}

// clearLocalCardState clears all local session-level state when the session token changes.
// Used by both SaveConfig and UserLogout to avoid stale data on new sessions.
func clearLocalCardState() {
	Log("[app] Session token changed: clearing local stats")
	GetUsageStats().Reset()
	GetLeaser().ResetLocalQuota()
	GetLeaser().ClearAccessKeyStatus()
	resetBoundFractions()
	// Clear leaser errors from the old session to avoid stale banners.
	GetLeaser().setLastError("")
	GetClaudeLeaser().setLastError("")
	GetCodexLeaser().setLastError("")
}

// GetStats returns combined proxy and leaser metrics
func (a *App) GetStats() map[string]interface{} {
	proxyStats := GetProxy().GetStats()
	leaserStatus := GetLeaser().GetStatus()
	// 血条两维度:整号上游余量(号余量条)+ 我的 fair-share 份额(我的卡条),各带恢复倒计时。
	// static 卡的"我的卡"额度来自 localQuota(见下方 accessKeyStatus/localQuota),不在这里。
	nowMs := time.Now().UnixMilli()
	leaserStatus["accountFractions"] = snapshotAccountFractions()
	leaserStatus["accountResetMs"] = snapshotAccountResets(nowMs)
	leaserStatus["myFractions"] = snapshotMyFractions()
	leaserStatus["myResetMs"] = snapshotMyResets(nowMs)
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

	// 统一错误归口:三套 leaser 的 lastError + 派生健康信号(代理未起/上报积压)
	// 汇成一个 notifications 列表(去重+分类),让 Claude/Codex 的租号错误也能进界面
	// (此前它们的 LastError() 无人读)。
	unifiedErr, _ := leaserStatus["lastError"].(string)
	notifications := buildNotifications([]errorSource{
		{Source: "antigravity", Msg: unifiedErr},
		{Source: "claude", Msg: GetClaudeLeaser().LastError()},
		{Source: "codex", Msg: GetCodexLeaser().LastError()},
	})
	notifications = append(notifications, derivedNotifications(clientHealth{
		CardConfigured: a.GetConfig().UserToken != "",
		ProxyRunning:   httpProxyStatus.Running,
		PendingReports: GetLeaser().pendingCount() + GetClaudeLeaser().pendingCount() + GetCodexLeaser().pendingCount(),
	})...)

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
		"notifications":    notifications,
		"httpProxy":        httpProxyStatus,
		"today":            usageStats.GetTodayRecord(),
		"dailyHistory":     usageStats.GetDailyRecords(30), // 下发 30 天,前端按 3日/周/月 切片
		"hourlyHistory":    usageStats.GetTodayHourlyRecords(),
		"chartMode":        chartMode,
		"cumulativeSaving": usageStats.GetCumulativeSavings(),
		"appVersion":       AppVersion,
		"updateStatus":     GetUpdater().GetStatus(),
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

	if cfg.UserToken != "" {
		GetLeaser().StartAutoLease(cfg.UserToken, cfg.DeviceId, "")
	}

	GetCodexProxy().ApplyConfig(cfg) // 重启时重新应用 Codex 中转模式配置
	return GetHTTPProxy().Start(cfg.ProxyPort, cfg.UserToken, cfg.DeviceId, "")
}

// SetClaudeDesktopMockLogin 开关 Claude 桌面端接管的「登录态 mock」。
// 开(默认,对齐 reclaude)：伪造已登录 pro，让没有 Claude 账号的用户也能用号池
// (桌面端 host-auth 下能否完全生效需实测)；关：透传 /api/hello 等，登录用户保持真实身份。
func (a *App) SetClaudeDesktopMockLogin(on bool) bool {
	GetMitmManager().SetMockLogin(on)
	return on
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
	IDEPath           string `json:"idePath"`
	HubPath           string `json:"hubPath"`
	CodexAppPath      string `json:"codexAppPath"`
	ClaudeDesktopPath string `json:"claudeDesktopPath"`
}

// GetDetectedPaths 获取自动检测到的 IDE/Hub 安装路径
func (a *App) GetDetectedPaths() DetectedPaths {
	return DetectedPaths{
		IDEPath:           detectAntigravityIDEPath(),
		HubPath:           detectAntigravityHubPath(),
		CodexAppPath:      detectCodexAppPath(),
		ClaudeDesktopPath: detectClaudeDesktopPathAuto(),
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
		required := targetRequiredProduct(t.ProductID())
		if !cardCoversProduct(products, required) {
			return "", fmt.Errorf("此卡未开通 %s,无法接管 %s(请使用对应产品的卡密,或改用池子卡)", productLabel(required), t.Name())
		}
		// 出口前置闸:配了静态出口代理的产品,接管前必须先探通出口(经代理能从代理 IP 出去),
		// 否则硬拒接管 —— 防止从用户真实 IP 直连官方暴露被封号(见 egress_preflight.go)。
		if err := enforceEgressGate(required, cfg); err != nil {
			return "", err
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

// OpenCACertForTrust 用系统证书 UI 打开根 CA(macOS:钥匙串访问;Windows:证书对话框),
// 供用户手动设为"始终信任"。仅作自动安装(admin + 用户域)都失败后的一键兜底 —— macOS 不允许
// 程序静默信任根 CA,但能替用户把证书直接打开,省掉找隐藏目录 ~/.bcai + 导航。前端在 CA_FAILED 时调用。
func (a *App) OpenCACertForTrust() error {
	return mitmOpenCACertForTrust()
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
		"changelog": status.Changelog, // 已是最新时 = 当前版本的更新内容
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

// GetFaqData 从服务器获取 FAQ 数据（绕过浏览器 CORS 限制）。
// 返回 { "items": [...], "settings": {...} }，失败返回空 map。
func (a *App) GetFaqData() map[string]interface{} {
	client := createHttpClient("")
	client.Timeout = 8 * time.Second

	result := map[string]interface{}{}

	// Fetch FAQ items
	for _, rawURL := range bcaiURLCandidates("https://" + BcaiPrimaryHost + "/api/faq") {
		resp, err := client.Get(rawURL)
		if err != nil {
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}
		var items []interface{}
		if json.Unmarshal(body, &items) == nil {
			result["items"] = items
		}
		break
	}

	// Fetch FAQ settings
	for _, rawURL := range bcaiURLCandidates("https://" + BcaiPrimaryHost + "/api/faq/settings") {
		resp, err := client.Get(rawURL)
		if err != nil {
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}
		var settings map[string]interface{}
		if json.Unmarshal(body, &settings) == nil {
			result["settings"] = settings
		}
		break
	}

	return result
}

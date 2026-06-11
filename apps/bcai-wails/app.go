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
		if _, err := GetLeaser().Activate(cfg.AccountCard, cfg.DeviceId, ""); err != nil {
			Log("[app] 启动时 Activate 失败(不阻塞自动租号): %v", err)
		}
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, "")
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
	err := GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, "")
	if err != nil {
		Log("[app] HTTP proxy start failed: %v", err)
	} else {
		Log("[app] HTTP proxy started on 127.0.0.1:%d", cfg.ProxyPort)
		a.proxyStartedAt = time.Now()
	}

	// 常驻启动 Claude 桌面端接管用的 MITM 代理(独立端口 48801)。仅监听,不影响任何流量;
	// 只有用户开启接管(装 CA + 带代理重启 Claude.app)后,Code/Cowork 子进程才会走它。
	if err := GetMitmManager().StartProxy(mitmDefaultPort, cfg.AccountCard, cfg.DeviceId, ""); err != nil {
		Log("[app] MITM 代理启动失败(不影响其它功能): %v", err)
	}

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
	if oldCfg.AccountCard != cfg.AccountCard ||
		oldCfg.ProxyPort != cfg.ProxyPort {

		Log("[app] Core settings changed. Restarting services...")

		// 换卡时清空本地统计数据 + 旧卡的 products(accessKeyStatus),避免用旧卡产品
		// 误判新卡是否开通 antigravity;新卡 products 由下面的 Activate 重新写入。
		if oldCfg.AccountCard != cfg.AccountCard {
			clearLocalCardState()
		}

		GetLeaser().StopAutoLease()
		GetHTTPProxy().Stop()

		if cfg.AccountCard != "" {
			// 重新 Activate 拿到(可能换了卡的)权威 products,再让 StartAutoLease 按产品决定
			// 是否跑 antigravity 自动租号,避免沿用旧卡 products 误判。
			if _, err := GetLeaser().Activate(cfg.AccountCard, cfg.DeviceId, ""); err != nil {
				Log("[app] 重启时 Activate 失败(不阻塞自动租号): %v", err)
			}
			GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, "")
		}

		// Restart HTTP proxy
		GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, "")
	} else {
		// Just update proxy config without restart
		GetHTTPProxy().UpdateConfig(cfg.AccountCard, cfg.DeviceId, "")
	}

	// MITM 代理端口固定,无需重启,只同步卡密/出口(覆盖上面两个分支)。
	GetMitmManager().UpdateConfig(cfg.AccountCard, cfg.DeviceId, "")

	return nil
}

// clearLocalCardState 换卡时清空所有本地卡级状态:用量统计、本地额度跟踪、缓存的
// 卡密状态(products)、以及绑定号血条残量。两条换卡路径(ActivateCard 与
// App.SaveConfig)共用,避免旧卡数据串到新卡。
func clearLocalCardState() {
	Log("[app] Account card changed: clearing local stats")
	GetUsageStats().Reset()
	GetLeaser().ResetLocalQuota()
	GetLeaser().ClearAccessKeyStatus()
	resetBoundFractions()
	// 三家 leaser 的额度/租号错误(如「卡额度已用完」红 banner)属旧卡,一并清掉 —— 否则
	// 换新卡 / 后台加额度后,旧卡的 block 提示会一直挂着。三家逻辑保持一致。
	GetLeaser().setLastError("")
	GetClaudeLeaser().setLastError("")
	GetCodexLeaser().setLastError("")
}

// switchCardConfig 把配置切到 newCard 并持久化;仅当卡确实变化时清空本地状态,
// 返回最新配置与是否发生了切换。无网络副作用,可单测。
func switchCardConfig(newCard string) (Config, bool) {
	cfg := LoadConfig()
	switched := cfg.AccountCard != newCard
	if switched {
		clearLocalCardState()
	}
	cfg.AccountCard = newCard
	_ = SaveConfig(cfg)
	return cfg, switched
}

// ActivateCard saves the account card/access key and validates it server-side.
func (a *App) ActivateCard(card string) (string, error) {
	cfg, _ := switchCardConfig(card)

	// Activation = card validation only (/api/activate). Whether a token can be
	// leased right now (account-pool availability) is a runtime concern, not an
	// activation failure — a momentarily dry pool must not block activation.
	expiresAt, err := GetLeaser().Activate(card, cfg.DeviceId, "")
	if err != nil {
		return "", err
	}

	// Start auto-lease / proxy so the client is ready to serve requests.
	GetLeaser().StartAutoLease(card, cfg.DeviceId, "")
	GetHTTPProxy().UpdateConfig(card, cfg.DeviceId, "")
	GetMitmManager().UpdateConfig(card, cfg.DeviceId, "")

	// Best-effort warm probe — never fatal. If the pool is momentarily dry the
	// card is still activated; the user just sees a "busy" hint at request time.
	// 只为开通了 antigravity 的卡(或池子卡)预热 —— codex-only 卡预热 antigravity 无意义,
	// 且会把"此卡未开通该服务"写进 lastError、弹给前端。
	if GetLeaser().coversAntigravity() {
		if _, leaseErr := GetLeaser().LeaseToken(card, cfg.DeviceId, true, nil, ""); leaseErr != nil {
			Log("[activate] card activated but warm lease failed (non-fatal): %v", leaseErr)
		}
	}

	return expiresAt, nil
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
	// 我的份额·周窗口(5h 之外的第二条血条;仅 codex/anthropic 绑卡有数据)。
	leaserStatus["myWeeklyFractions"] = snapshotMyWeeklyFractions()
	leaserStatus["myWeeklyResetMs"] = snapshotMyWeeklyResets(nowMs)
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
		CardConfigured: a.GetConfig().AccountCard != "",
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

	if cfg.AccountCard != "" {
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, "")
	}

	GetCodexProxy().ApplyConfig(cfg) // 重启时重新应用 Codex 中转模式配置
	return GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, "")
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

// InstallStandaloneClaude 用 winget 从社区源(--source winget,非微软商店 msstore)静默安装官方
// 独立版 Claude Desktop —— 装出可被接管的独立安装器版,替代商店 MSIX 版。前端「一键安装独立版」
// 按钮调用。在可见控制台里跑 winget(用户能看下载/安装进度),立即返回不阻塞 UI。winget 不存在时
// 返回 winget_not_found,前端据此回退到打开官网下载页。仅 Windows。
func (a *App) InstallStandaloneClaude() error {
	if goruntime.GOOS != "windows" {
		return fmt.Errorf("仅 Windows 支持 winget 一键安装")
	}
	if _, err := exec.LookPath("winget"); err != nil {
		return fmt.Errorf("winget_not_found")
	}
	// cmd /c start 开一个新控制台跑 winget(可见进度);hideCmd 只藏掉这个发起的 cmd 自身,
	// 避免闪一个空窗口。winget 自带的控制台窗口照常显示。
	return hideCmd("cmd", "/c", "start", "", "winget", "install",
		"--id", "Anthropic.Claude", "--source", "winget", "-e",
		"--accept-source-agreements", "--accept-package-agreements").Start()
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

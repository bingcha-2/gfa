package main

import (
	"fmt"
	"runtime"
)

// ─── Takeover 抽象层 ────────────────────────────────────────────────────────
//
// 每个可"接管"的目标(Antigravity IDE / Hub、Codex、未来的其它 app)实现统一的
// TakeoverTarget 接口:检测、判断是否已接管、接管(含重启)、还原(含重启)。
// DetectIDEProducts / InjectSelected / RestoreSelected 全部基于注册表泛化驱动,
// 新增一个产品 = 实现接口 + 注册一行,无需改动调度逻辑。
//
// 注意:本层只"编排",不重写各产品的注入细节(settings/asar/config.toml 的具体
// 读写仍在 ide_inject.go / codex_inject.go),把易碎的实现隔离在叶子里。

type TakeoverTarget interface {
	Key() string           // 调度键:"ide" | "hub" | "codex"
	ProductID() string     // 前端产品 id:"antigravity_ide" | "antigravity_hub" | "codex"
	Name() string          // 展示名
	InjectionType() string // "settings" | "asar" | "config"
	DetectPath() string    // 安装路径(空=未检测到)
	IsInjected(proxyPort int) bool
	// Inject 接管并完成必要的重启,返回面向用户的状态消息。
	Inject(proxyPort int) (string, error)
	// Restore 还原并完成必要的重启,返回面向用户的状态消息。
	Restore() (string, error)
}

func takeoverProxyURL(proxyPort int) string {
	return fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
}

// caTakeoverHint 按【平台 + 根 CA 安装结局】生成接管后的面向用户反馈(含前端识别用的
// CA_DEGRADED: / CA_FAILED: 前缀)。拆成纯函数 + 带 goos 入参,是因为"装证书失败/降级后该
// 怎么办"在两平台是两套完全不同的操作:Windows 走 UAC / 右键以管理员身份运行;macOS 没有
// "以管理员身份运行 App"这回事 —— 得用管理员账户登录、在本机物理屏幕前操作,或在钥匙串访问里
// 手动设"始终信任"(且证书在隐藏目录 ~/.bcai,得用访达 ⌘⇧G 前往,不能直接双击)。
func caTakeoverHint(goos string, result caInstallResult) string {
	switch result {
	case caInstalledUser:
		if goos == "windows" {
			return "CA_DEGRADED:Claude Desktop 已接管,推理功能可正常使用。\n\n" +
				"但根证书因权限受限,已降级安装到「当前用户」证书库。若打开 Claude 出现【白屏】,请按任一方式处理后重新接管:\n" +
				"1. 临时关闭安全软件(火绒 / 360 等)的「主动防御」;\n" +
				"2. 或右键以【管理员身份】重新运行本程序。"
		}
		return "CA_DEGRADED:Claude Desktop 已接管,推理功能可正常使用。\n\n" +
			"根证书因权限受限,已降级安装到「当前用户」信任域(免管理员),订阅等级通常仍可显示为 Max。" +
			"若未显示或打开异常,请用【管理员账户】登录、在本机物理屏幕前(勿用远程桌面 / 屏幕共享)重新接管。"
	case caInstallFailed:
		// 不再自称"接管成功":推理确实 OK,但证书没装、Max 没出来,把两件事拆开讲。
		if goos == "windows" {
			return "CA_FAILED:✅ 推理已接管,号池可正常使用(发消息照常)。\n" +
				"⚠️ 但根证书没装上,Max 等级标识不会显示。\n\n" +
				"想要 Max:右键以【管理员身份】重新运行本程序、再重新接管;若被安全软件(火绒 / 360 等)拦截,先在其中放行。"
		}
		return "CA_FAILED:✅ 推理已接管,号池可正常使用(发消息照常)。\n" +
			"⚠️ 但根证书没装上,Max 等级标识不会显示。\n\n" +
			"点【重新接管 · 装证书】会再弹一次系统密码框,输入即可装上并显示 Max(会重启 Claude)。刚才若点了「取消」,再来一次输入密码即可。\n\n" +
			"反复装不上(安全软件拦截 / 远程会话弹不出框 / 受管 Mac)可手动信任:打开「钥匙串访问」,找到「BingchaAI Local Root」→ 双击 → 展开「信任」→「使用此证书时」选『始终信任』→ 输密码。"
	default: // caInstalledMachine:装进本机/系统域,最优,无需任何提示
		return "Claude Desktop: ✓ 已接管,正在重启 Claude(将中断 Cowork 会话)..."
	}
}

// 注册表:新增产品在这里加一行即可。
var takeoverTargets = []TakeoverTarget{
	antigravityIDETarget{},
	antigravityHubTarget{},
	codexTarget{},
	claudeCodeTarget{},
	claudeDesktopTarget{},
}

// findTakeoverTarget 按调度键或产品 id 查找。
func findTakeoverTarget(idOrKey string) TakeoverTarget {
	for _, t := range takeoverTargets {
		if t.Key() == idOrKey || t.ProductID() == idOrKey {
			return t
		}
	}
	return nil
}

// targetRequiredProduct 把接管目标的 ProductID 映射到所需的 GFA 产品(池)。
// antigravity IDE/Hub 都走 antigravity 池;codex 走 codex 池;未知目标返回空(不限制)。
func targetRequiredProduct(productID string) string {
	switch productID {
	case "codex":
		return "codex"
	case "antigravity_ide", "antigravity_hub":
		return "antigravity"
	case "claude_code", "claude_desktop":
		return "anthropic"
	default:
		return ""
	}
}

// cardCoversProduct 判断卡是否开通了某产品。池子卡(products 为空)覆盖一切;
// 绑定卡只覆盖自己绑定的产品。required 为空时不限制(放行)。
func cardCoversProduct(cardProducts []string, required string) bool {
	if required == "" || len(cardProducts) == 0 {
		return true
	}
	for _, p := range cardProducts {
		if p == required {
			return true
		}
		// 过渡兼容:产品 claude 已改名 anthropic,但新客户端可能连到尚未升级的服务端
		// (仍下发 products=["claude"])。把旧值 claude 视作 anthropic,避免门控错配。
		if required == "anthropic" && p == "claude" {
			return true
		}
	}
	return false
}

func productLabel(product string) string {
	switch product {
	case "codex":
		return "Codex"
	case "antigravity":
		return "Antigravity"
	case "anthropic":
		return "Anthropic"
	default:
		return product
	}
}

// validateTakeoverPrereqs 接管前置校验:需已登录账号(官方透传)。
func validateTakeoverPrereqs(cfg Config) error {
	if cfg.UserToken == "" {
		return fmt.Errorf("请先登录账号再开启接管")
	}
	return nil
}

// ── Antigravity IDE(settings.json 注入)──────────────────────────────────

type antigravityIDETarget struct{}

func (antigravityIDETarget) Key() string           { return "ide" }
func (antigravityIDETarget) ProductID() string     { return "antigravity_ide" }
func (antigravityIDETarget) Name() string          { return "Antigravity IDE" }
func (antigravityIDETarget) InjectionType() string { return "settings" }
func (antigravityIDETarget) DetectPath() string    { return detectAntigravityIDEPathCached() }

func (antigravityIDETarget) IsInjected(proxyPort int) bool {
	settingsPath := getIDESettingsPath()
	if settingsPath == "" {
		return false
	}
	return checkSettingsInjected(settingsPath, takeoverProxyURL(proxyPort))
}

func (antigravityIDETarget) Inject(proxyPort int) (string, error) {
	if err := InjectIDESettings(proxyPort); err != nil {
		return "", err
	}
	// 写入 settings.json 后完整重启 IDE(只杀 LS 不够:extension host 会缓存旧端口)。
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[takeover] IDE 重启 goroutine panic: %v", r)
			}
		}()
		if err := ForceRestartIDE(); err != nil {
			Log("[takeover] 完整重启 IDE 失败: %v", err)
		}
	}()
	return "Antigravity IDE: ✓ 已接管,正在重启 IDE...", nil
}

func (antigravityIDETarget) Restore() (string, error) {
	if err := RestoreIDESettings(); err != nil {
		return "", err
	}
	if IsIDERunning() {
		RestartLanguageServerIfNeeded(0) // port=0 强制不匹配,杀 LS 重启
		return "Antigravity IDE: ✓ 已恢复（language_server 将自动重启）", nil
	}
	return "Antigravity IDE: ✓ 已恢复", nil
}

// ── Antigravity Hub(app.asar 补丁)─────────────────────────────────────────

type antigravityHubTarget struct{}

func (antigravityHubTarget) Key() string           { return "hub" }
func (antigravityHubTarget) ProductID() string     { return "antigravity_hub" }
func (antigravityHubTarget) Name() string          { return "Antigravity Hub" }
func (antigravityHubTarget) InjectionType() string { return "asar" }
func (antigravityHubTarget) DetectPath() string    { return detectAntigravityHubPathCached() }

func (antigravityHubTarget) IsInjected(proxyPort int) bool {
	hubPath := detectAntigravityHubPathCached()
	if hubPath == "" {
		return false
	}
	return checkAsarPatchedCached(getAsarPath(hubPath), takeoverProxyURL(proxyPort))
}

func (antigravityHubTarget) Inject(proxyPort int) (string, error) {
	if detectAntigravityHubPath() == "" {
		return "Antigravity Hub: 未检测到应用", nil
	}
	// Hub 运行时 app.asar 被 Electron 锁定,先关闭再 patch。
	hubWasRunning := IsHubRunning()
	if hubWasRunning {
		Log("[takeover] Hub 正在运行,先关闭以解锁 app.asar...")
		killHubForPatch()
	}
	if err := PatchAsar(proxyPort); err != nil {
		if hubWasRunning {
			_ = LaunchHub() // patch 失败也尝试恢复原状
		}
		return "", err
	}
	if err := LaunchHub(); err != nil {
		Log("[takeover] Hub 启动失败: %v", err)
		return "Antigravity Hub: ✓ 已接管,但启动失败", nil
	}
	return "Antigravity Hub: ✓ 已接管并启动", nil
}

func (antigravityHubTarget) Restore() (string, error) {
	if err := RestoreAsar(); err != nil {
		return "", err
	}
	if IsHubRunning() {
		if err := KillAndRestartHub(); err != nil {
			return "Antigravity Hub: ✓ 已恢复,但重启失败", nil
		}
		return "Antigravity Hub: ✓ 已恢复并重启", nil
	}
	return "Antigravity Hub: ✓ 已恢复", nil
}

// ── Codex.app(~/.codex/config.toml 注入)──────────────────────────────────

type codexTarget struct{}

func (codexTarget) Key() string           { return "codex" }
func (codexTarget) ProductID() string     { return "codex" }
func (codexTarget) Name() string          { return "Codex" }
func (codexTarget) InjectionType() string { return "config" }
func (codexTarget) DetectPath() string    { return detectCodexAppPath() }
func (codexTarget) IsInjected(_ int) bool { return IsCodexInjected() }

func (codexTarget) Inject(proxyPort int) (string, error) {
	if detectCodexAppPath() == "" {
		return "Codex: 未检测到应用", nil
	}
	if err := InjectCodexSettings(proxyPort); err != nil {
		return "", err
	}
	// 接管即租号:清掉任何遗留的「中转(relay)」配置,确保生成请求走 bcai 号池租号,
	// 而不是被旧的中转配置劫持到外部中转站(如 litellm)。热生效,无需重启代理。
	if cleared, err := ensureCodexRentalMode(); err != nil {
		return "", err
	} else if cleared {
		Log("[codex] 接管已清除遗留的中转(relay)配置,切回租号模式")
	}
	// 纯 CLI 安装:config 已写入并即时生效(CLI 每次运行现读),没有常驻 GUI 需要重启、
	// 也没有 state_5.sqlite 历史需要 retag。直接返回,提示重开终端。
	if !codexGUIInstalled() {
		return "Codex CLI: ✓ 已接管,重开终端(或重新运行 codex)即可生效", nil
	}
	// GUI 桌面版:切到自定义 provider(bingchaai)→ 退出 Codex → 把历史 retag 到 bingchaai
	// (当前 provider 视图下可见)→ 重启,让常驻进程重读 config。
	go RestartCodexAfterTakeover(codexProviderID)
	return "Codex: ✓ 已接管,正在重启 Codex...", nil
}

func (codexTarget) Restore() (string, error) {
	if err := RestoreCodexSettings(); err != nil {
		return "", err
	}
	// 纯 CLI:同 Inject,无 GUI 可重启、无 sqlite 历史需 retag。
	if !codexGUIInstalled() {
		return "Codex CLI: ✓ 已恢复,重开终端(或重新运行 codex)即可生效", nil
	}
	// GUI:还原后回到官方 openai provider → 把历史 retag 回 openai → 重启。
	go RestartCodexAfterTakeover(codexDefaultProvider)
	return "Codex: ✓ 已恢复,正在重启 Codex...", nil
}

// ── Claude Code(~/.claude/settings.json env 注入,CLI + VSCode 扩展共用)──────

type claudeCodeTarget struct{}

func (claudeCodeTarget) Key() string           { return "claude" }
func (claudeCodeTarget) ProductID() string     { return "claude_code" }
func (claudeCodeTarget) Name() string          { return "Claude Code" }
func (claudeCodeTarget) InjectionType() string { return "settings" }
func (claudeCodeTarget) DetectPath() string    { return detectClaudeCodePath() }

func (claudeCodeTarget) IsInjected(proxyPort int) bool { return IsClaudeInjected(proxyPort) }

func (claudeCodeTarget) Inject(proxyPort int) (string, error) {
	if err := InjectClaudeSettings(proxyPort); err != nil {
		return "", err
	}
	// Claude Code CLI 无常驻进程:注入后下次 `claude` 启动即生效,无需杀进程。
	// VSCode 的 Claude Code 扩展需 Reload Window 才会重读 settings.json。
	return "Claude Code: ✓ 已接管(CLI 下次启动生效;VSCode 扩展请 Reload Window)", nil
}

func (claudeCodeTarget) Restore() (string, error) {
	if err := RestoreClaudeSettings(); err != nil {
		return "", err
	}
	return "Claude Code: ✓ 已恢复(CLI 下次启动生效;VSCode 扩展请 Reload Window)", nil
}

// ── Claude 桌面端 Code/Cowork(MITM 接管)──────────────────────────────────────
//
// 桌面端 spawn 的 Code/Cowork 子进程硬覆盖 ANTHROPIC_BASE_URL，env 注入无效，
// 故走 MITM：装根 CA + 带代理 env 重启 Claude.app(route A)，把 api.anthropic.com
// 的 /v1/messages 拦下换号池 token。MITM 代理由 app.go 常驻启动并随卡密同步;接管激活期间
// 由看门狗维持运行(挂掉自愈重起)。注意：本接管会重启 Claude.app，会中断正在运行的 Cowork 会话。

type claudeDesktopTarget struct{}

func (claudeDesktopTarget) Key() string           { return "claude_desktop" }
func (claudeDesktopTarget) ProductID() string     { return "claude_desktop" }
func (claudeDesktopTarget) Name() string          { return "Claude Desktop (Code/Cowork)" }
func (claudeDesktopTarget) InjectionType() string { return "mitm" }
func (claudeDesktopTarget) DetectPath() string    { return detectClaudeDesktopPath() }

func (claudeDesktopTarget) IsInjected(_ int) bool { return mitmIsTakeoverActive() }

func (claudeDesktopTarget) Inject(_ int) (string, error) {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return "Claude Desktop: 未检测到应用", nil
	}
	m := GetMitmManager()
	if !m.IsProxyRunning() {
		return "", fmt.Errorf("MITM 代理未启动")
	}
	// 清掉用户自定义模型配置(settings.json 顶层 model 字段 + 模型 env 键),让桌面端 spawn 的
	// Code 子进程重启后回落到自带合法默认模型 id —— 否则 -thinking 等别名 / 号池不认的 id 会经
	// MITM 原样打到公开 api.anthropic.com → 404。原值已备份,Restore 时还原。失败不阻塞接管。
	if err := CleanClaudeModelConfig(); err != nil {
		Log("[takeover] 清理 Claude 模型配置失败(不阻塞接管): %v", err)
	}

	// ① 同步装根 CA(+伪凭证),先把证书装好再谈重启。同步执行是为了【在重启之前】拿到安装结局,
	//    据此给前端分级提示:装进本机库=静默无提示;降级用户库=提示白屏排查;全失败=提示无 Max。
	caResult := m.InstallTakeoverCA()

	// ② Microsoft Store(MSIX)版:跑在 AppX 系统沙箱里,带代理重启从机制上做不到(CreateProcess
	//    撞 Access denied、env/argv 进不去沙箱,详见 isMicrosoftStoreClaude)。把判定放在【装完 CA 之后】
	//    而非接管入口 —— 满足「先尝试再说」,且【绝不进 relaunch】(否则会先杀掉用户正在跑的 Claude 再失败、
	//    白白中断对话)。直接返回 STORE_CLAUDE: 引导换装独立安装器版。
	if isMicrosoftStoreClaude(bin) {
		Log("[takeover] 检测到 Microsoft Store 版 Claude Desktop,跳过重启(沙箱无法注入代理),引导换装。CA 安装结局=%d", caResult)
		return "", fmt.Errorf("STORE_CLAUDE:检测到 Microsoft Store(应用商店)版 Claude Desktop，无法接管 —— " +
			"商店版跑在系统沙箱里，无法携带代理启动。两种解决方法：" +
			"①让 Agent 执行（把 Claude Desktop 安装目录移动到 D:\\ClaudeDesktop，并在原默认路径创建 junction，确保系统仍能正常识别和启动）操作；" +
			"②安装非应用商店独立版 ClaudeDesktop。")
	}

	// ③ 非 store 版:异步带代理重启 Claude.app(会杀掉当前 Cowork 会话)。异步是为了不阻塞 UI,
	//    且与 mac/其它 target 行为一致。重启细节见 RelaunchClaudeProcess。
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[takeover] Claude Desktop 重启 goroutine panic: %v", r)
			}
		}()
		if err := m.RelaunchClaudeProcess(caResult); err != nil {
			Log("[takeover] 带代理重启 Claude Desktop 失败: %v", err)
		}
	}()

	// ④ 按【平台 + CA 安装结局】给前端分级反馈(前缀供前端识别弹对应提示;接管本身已照常进行)。
	//    平台相关文案见 caTakeoverHint:Windows 走 UAC/管理员运行,macOS 走管理员账户/钥匙串手动信任。
	return caTakeoverHint(runtime.GOOS, caResult), nil
}

func (claudeDesktopTarget) Restore() (string, error) {
	// 还原接管时清掉的用户自定义模型配置(若 Claude Code 完整接管仍在用则跳过,保持清除态)。
	if err := RestoreClaudeModelConfig(); err != nil {
		Log("[takeover] 还原 Claude 模型配置失败: %v", err)
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[takeover] Claude Desktop 还原 goroutine panic: %v", r)
			}
		}()
		if err := GetMitmManager().RelaunchClaudePlain(); err != nil {
			Log("[takeover] 还原重启 Claude Desktop 失败: %v", err)
		}
	}()
	return "Claude Desktop: ✓ 已恢复,正在重启 Claude...", nil
}

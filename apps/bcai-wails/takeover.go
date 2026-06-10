package main

import "fmt"

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

// validateTakeoverPrereqs 接管前置校验:需已激活账号卡(官方透传)。
func validateTakeoverPrereqs(cfg Config) error {
	if cfg.AccountCard == "" {
		return fmt.Errorf("请先激活账号卡再开启接管")
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
	// 切到自定义 provider(bingchaai)→ 退出 Codex → 把历史 retag 到 bingchaai
	// (当前 provider 视图下可见)→ 重启。
	go RestartCodexAfterTakeover(codexProviderID)
	return "Codex: ✓ 已接管,正在重启 Codex...", nil
}

func (codexTarget) Restore() (string, error) {
	if err := RestoreCodexSettings(); err != nil {
		return "", err
	}
	// 还原后回到官方 openai provider → 把历史 retag 回 openai。
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
// 的 /v1/messages 拦下换号池 token。MITM 代理由 app.go 常驻启动并随卡密同步。
// 注意：本接管会重启 Claude.app，会中断正在运行的 Cowork 会话。

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
	// Microsoft Store(MSIX)版跑在系统沙箱里,接管做不到(详见 isMicrosoftStoreClaude)。
	// 这里提前拒绝并给出可操作指引,而不是进 goroutine 后硬 exec 撞 Access is denied、刷屏失败。
	// STORE_CLAUDE: 前缀供前端识别 → 弹「去下载独立安装器」引导(与 EGRESS_BLOCKED: 同理),
	// 不带 URL:下载链接由前端按钮承载,避免链接混进提示文案。
	if isMicrosoftStoreClaude(bin) {
		return "", fmt.Errorf("STORE_CLAUDE:检测到 Microsoft Store(应用商店)版 Claude Desktop,无法接管 —— " +
			"商店版跑在系统沙箱里,既不能带代理重启、也无法注入证书环境。请改装官方独立安装器版本后重试。")
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
	// 重启会做两件事(见 RelaunchClaudeWithProxy)：
	//   1. Node 侧(Code/Cowork 子进程)：注入 NODE_EXTRA_CA_CERTS + HTTPS_PROXY 即走 MITM。
	//   2. Chromium 侧(登录页/升级墙/主聊天)：装根 CA 进系统钥匙串(弹管理员授权) + --proxy-server，
	//      才能解密并掀翻 Chromium 画的付费墙。装 CA 失败不阻塞，Node 侧推理仍可走号池。
	// 退出并带代理重启 Claude.app（异步：会杀掉当前 Cowork 会话）。
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[takeover] Claude Desktop 重启 goroutine panic: %v", r)
			}
		}()
		if err := m.RelaunchClaudeWithProxy(); err != nil {
			Log("[takeover] 带代理重启 Claude Desktop 失败: %v", err)
		}
	}()
	return "Claude Desktop: ✓ 已接管,正在重启 Claude(将中断 Cowork 会话)...", nil
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

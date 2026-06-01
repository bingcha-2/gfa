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

// validateTakeoverPrereqs 接管前置校验:remote 模式需卡密,local 模式需号池账号。
func validateTakeoverPrereqs(cfg Config) error {
	poolMode := cfg.PoolMode
	if poolMode == "" {
		poolMode = "remote"
	}
	if poolMode == "remote" && cfg.AccountCard == "" {
		return fmt.Errorf("请先激活账号卡再开启接管")
	}
	if poolMode == "local" {
		poolStatus := GetAccountPool().GetPoolStatus()
		total, _ := poolStatus["total"].(int)
		if total <= 0 {
			return fmt.Errorf("本地号池为空，请先添加账号再开启接管")
		}
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

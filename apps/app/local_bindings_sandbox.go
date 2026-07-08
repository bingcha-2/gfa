package main

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 沙箱模式接管 Wails 绑定。冰茶只准备(装/配/递命令),交互式 sbx run 由用户在自己终端跑。
// 触机器动作在 sandbox_takeover.go 已过 appActionsSuppressed() 短路。

// SandboxGetStatus 卡片状态(sbx 是否装、版本、Linux KVM)。
func (a *App) SandboxGetStatus() SbxStatus { return DetectSbx() }

// SandboxInstall 打开系统终端并跑 sbx 安装命令(可见、可交互)。失败(开不了终端)由前端
// 回退到 SandboxInstallCommand 让用户手动复制。
func (a *App) SandboxInstall() error { return InstallSbx() }

// SandboxInstallCommand 返回安装 sbx 的命令(SandboxInstall 开终端失败时的兜底,让用户手动复制)。
func (a *App) SandboxInstallCommand() string { return currentInstallCommandString() }

// SandboxBrowseDir 弹「目录」选择框(挂载目录用),返回所选目录(空=取消)。
// 用 OpenDirectoryDialog 而非 BrowseForPath(那是选 .app/.exe 文件的,选不了文件夹)。
func (a *App) SandboxBrowseDir(title string) string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil {
		return ""
	}
	return dir
}

// SandboxWindowsPrereq Windows 前置检查(WHP + 固件虚拟化)。非 Windows 返回全 OK。
func (a *App) SandboxWindowsPrereq() WinPrereq { return windowsPrereq() }

// SandboxEnableHypervisor 弹 UAC 启用 Windows Hypervisor Platform(启用后需重启)。
func (a *App) SandboxEnableHypervisor() error { return enableWindowsHypervisor() }

// SandboxLogin 开终端跑 sbx login(Docker Hub 登录,首次使用必做)。
func (a *App) SandboxLogin() error { return SbxLogin() }

// ── VSCode 扩展沙箱接管(第 7 目标)──
// SandboxVscodeStatus 卡片状态(VSCode 装没、sbx 装没、是否已接管)。
func (a *App) SandboxVscodeStatus() VscodeSandboxStatus { return vscodeSandboxStatus() }

// SandboxVscodeEnable 接管:写 wrapper 脚本 + claudeProcessWrapper 设置(沙箱由扩展下次启动惰性建)。
func (a *App) SandboxVscodeEnable() (string, error) {
	if err := validateTakeoverPrereqs(LoadConfig()); err != nil {
		return "", err
	}
	return claudeVscodeSandboxTarget{}.Inject(effectiveProxyPort())
}

// SandboxVscodeDisable 还原:清设置 + 删脚本。
func (a *App) SandboxVscodeDisable() (string, error) { return claudeVscodeSandboxTarget{}.Restore() }

// SandboxModelCfg 自定义模型配置。Custom=false(默认)→ 走冰茶网关租号;
// Custom=true → 沙箱里的 Claude Code 直连自定义 Anthropic 兼容端点(如火山方舟 kimi)。
type SandboxModelCfg struct {
	Custom  bool   `json:"custom"`
	BaseURL string `json:"baseURL"` // ANTHROPIC_BASE_URL(须 Anthropic 兼容,如 .../api/plan)
	Token   string `json:"token"`   // ANTHROPIC_AUTH_TOKEN
	Model   string `json:"model"`   // ANTHROPIC_MODEL(如 kimi-k2.6)
}

// SandboxCreate 生成 kit + 放行 policy + 后台建 box(sbx create,box 建完 stopped,不进入)。
// 返回建好的 box 名,前端据此进列表 / 拿「进入」命令。进入的交互 TUI 才需终端,建 box 冰茶后台干。
// model.Custom=false 走冰茶网关(默认);=true 直连自定义模型端点。
// openNetwork=true → 沙箱网络全放开(caps.network.allow=**);文件隔离不受影响(microVM 只见挂载目录)。
// 时区不再由用户手选:冰茶托管按粘性租约出口 IP 自动探,探不到兜底美东;自定义模型无租约,固定美东。
func (a *App) SandboxCreate(mounts []SandboxMount, model SandboxModelCfg, openNetwork bool) (string, error) {
	custom := model.Custom && strings.TrimSpace(model.BaseURL) != ""
	// 自定义模型不依赖冰茶租号,故不强制登录冰茶账号;冰茶托管才校验。
	if !custom {
		if err := validateTakeoverPrereqs(LoadConfig()); err != nil {
			return "", err
		}
	}
	port := effectiveProxyPort()
	o := defaultKitOptions(port)
	if custom {
		o.BaseURL = strings.TrimSpace(model.BaseURL)
		o.AuthToken = strings.TrimSpace(model.Token)
		o.Model = strings.TrimSpace(model.Model)
		if h := hostFromURL(o.BaseURL); h != "" {
			o.NetworkAllow = h // 放行自定义模型域名;冰茶网关 localhost 由 ApplyPolicy 顺带放行,无害
		}
	}
	if openNetwork {
		o.NetworkAllow = "**" // 该沙箱全放开网络(仅此沙箱,不动全局;文件仍只见挂载目录)
	}
	if !custom {
		// 冰茶托管:按粘性租约出口 IP 探时区,对齐出口地理;探不到则保持默认美东。
		// 自定义模型无租约,不探,固定默认美东。
		if tz, err := probeExitTimezone(GetLeaser().CurrentEgressProxyURL()); err == nil {
			o.Timezone = tz
		}
	}
	kitDir, err := GenerateKit(o)
	if err != nil {
		return "", err
	}
	if err := ApplyPolicy(port); err != nil {
		return "", err
	}
	name := sandboxName(mounts)
	if err := createSandbox(name, kitDir, mounts); err != nil {
		return "", err
	}
	return name, nil
}

// SandboxEnterCommand 「进入」命令(复制到终端)。box 已由 SandboxCreate 建好(kit/工作区/挂载烧进 spec),
// 故进入只需 sbx run --name;skipPermissions 时给沙箱里的 claude 加 --dangerously-skip-permissions。
func (a *App) SandboxEnterCommand(name string, skipPermissions bool) string {
	return enterCommandString(name, skipPermissions)
}

// SandboxList 真实存在的托管沙箱(查 sbx ls --json,只认 gfa- 前缀,含状态/工作区/来源)。永不返回 nil。
func (a *App) SandboxList() []SandboxInfo {
	if infos := listManagedSandboxes(); infos != nil {
		return infos
	}
	return []SandboxInfo{}
}

// SandboxStopOne 停止并移除单个托管沙箱(sbx rm --force)。安全线只动 gfa- 前缀;失败原因透给前端。
// 停完前端会重查 sbx ls,列表自然反映真实状态。
func (a *App) SandboxStopOne(name string) error { return stopSandbox(name) }

// SandboxRestore 移除沙箱配置(删 kit + 撤 policy)。
func (a *App) SandboxRestore() (string, error) {
	return claudeSandboxTarget{}.Restore()
}

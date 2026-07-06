package main

import "github.com/wailsapp/wails/v2/pkg/runtime"

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

// SandboxUSTimezones 供前端时区下拉。
func (a *App) SandboxUSTimezones() []string { return usTimezones() }

// SandboxPrepare 生成带挂载/时区的 kit + 放行 policy,返回给用户复制到终端的命令。
// timezone 空则用默认(America/New_York)。Phase 2 会在此处按出口 IP 覆盖 timezone。
func (a *App) SandboxPrepare(mounts []SandboxMount, timezone string, skipPermissions bool) (string, error) {
	if err := validateTakeoverPrereqs(LoadConfig()); err != nil {
		return "", err
	}
	port := effectiveProxyPort()
	o := defaultKitOptions(port)
	if timezone != "" {
		// 用户在 UI 显式选了时区 → 尊重用户。
		o.Timezone = timezone
	} else if tz, err := probeExitTimezone(GetLeaser().CurrentEgressProxyURL()); err == nil {
		// Phase 2:未指定则按当前粘性租约的出口 IP 探一次地理时区(失败回退默认美东)。
		o.Timezone = tz
	}
	kitDir, err := GenerateKit(o)
	if err != nil {
		return "", err
	}
	if err := ApplyPolicy(port); err != nil {
		return "", err
	}
	// 固定命名(gfa-claude-<项目名>)+ 记进名单(多项目:不覆盖,支持列表管理)。
	name := sandboxName(mounts)
	if err := addManagedName(name); err != nil {
		Log("[sandbox] 记录托管沙箱名失败(不致命): %v", err)
	}
	return runCommandString(name, kitDir, mounts, skipPermissions), nil
}

// SandboxList 已托管的沙箱名单(gfa-claude-<项目名>)。永不返回 nil(避免前端 null.length 白屏)。
func (a *App) SandboxList() []string {
	if names := listManagedNames(); names != nil {
		return names
	}
	return []string{}
}

// SandboxStopOne 停止单个托管沙箱(sbx rm,尽力而为)并从名单移除。安全线只动 gfa- 前缀。
func (a *App) SandboxStopOne(name string) error {
	if err := stopSandbox(name); err != nil {
		Log("[sandbox] 停止沙箱 %s 失败(仍从名单移除): %v", name, err)
	}
	return removeManagedName(name)
}

// SandboxRestore 移除沙箱配置(删 kit + 撤 policy)。
func (a *App) SandboxRestore() (string, error) {
	return claudeSandboxTarget{}.Restore()
}

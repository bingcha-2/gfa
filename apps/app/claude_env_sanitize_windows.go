//go:build windows

package main

import "fmt"

// scanOSEnvConflicts 读取 Windows 用户级/系统级环境变量里的第三方 ANTHROPIC_BASE_URL。
// 这类 OS 级变量在 mac/Linux 上来自 shell rc（已由 scanShellRCConflicts 覆盖），
// Windows 则持久化在注册表 Environment 键下，需单独读。
func scanOSEnvConflicts(proxyPort int) []ClaudeConfigConflict {
	roots := []struct {
		path  string
		scope string
	}{
		{`HKCU\Environment`, "user"},
		{`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, "machine"},
	}
	var conflicts []ClaudeConfigConflict
	for _, r := range roots {
		out, err := hideCmd("reg", "query", r.path, "/v", claudeBaseURLKey).CombinedOutput()
		if err != nil {
			continue // 键不存在时 reg 返回非零，视作无冲突
		}
		val, ok := parseRegQueryValue(string(out), claudeBaseURLKey)
		if !ok || val == "" || isGFAOwnedRelayValue(val, proxyPort) {
			continue
		}
		conflicts = append(conflicts, ClaudeConfigConflict{
			ID:       "os-env:" + r.scope,
			Kind:     "os-env",
			Scope:    r.scope,
			Location: r.path + `\` + claudeBaseURLKey,
			Detail:   claudeBaseURLKey + "=" + val,
			Severity: "blocking",
		})
	}
	return conflicts
}

// killCcSwitchProcess 结束 cc-switch 托盘进程（best-effort）。
func killCcSwitchProcess() {
	_ = hideCmd("taskkill", "/IM", "cc-switch.exe", "/T", "/F").Run()
}

// deleteManagedSettingsElevated 经 PowerShell RunAs 提权删除企业策略文件（弹一次 UAC）。
func deleteManagedSettingsElevated(path string) error {
	ps := fmt.Sprintf(
		`$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','del','/f','/q','%s' -Verb RunAs -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode`,
		path)
	return hideCmd("powershell", "-NoProfile", "-Command", ps).Run()
}

// deleteOSEnvVar 删除注册表 Environment 键下的 ANTHROPIC_BASE_URL。machine 级需管理员，
// best-effort：失败由 SanitizeCompetingClaudeConfig 的删后复检兜住（保留在 Skipped）。
func deleteOSEnvVar(scope string) error {
	root := `HKCU\Environment`
	if scope == "machine" {
		root = `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
	}
	return hideCmd("reg", "delete", root, "/v", claudeBaseURLKey, "/f").Run()
}

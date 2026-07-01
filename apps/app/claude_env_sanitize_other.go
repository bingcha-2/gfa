//go:build !windows

package main

import (
	"fmt"
	"os"
	"runtime"
)

// scanOSEnvConflicts 在非 Windows 平台上无额外来源：OS 级 ANTHROPIC_* 变量来自 shell
// 启动脚本，已由 scanShellRCConflicts 覆盖。此处返回空，保持编排器跨平台调用一致。
func scanOSEnvConflicts(proxyPort int) []ClaudeConfigConflict { return nil }

// killCcSwitchProcess 结束 cc-switch 托盘进程（best-effort，无匹配也不报错）。
func killCcSwitchProcess() {
	_ = hideCmd("pkill", "-f", "cc-switch").Run()
}

// deleteManagedSettingsElevated 删除企业策略文件。macOS 经 osascript 提权（弹密码框）；
// Linux 直接删（best-effort，通常需以 root 运行客户端）。
func deleteManagedSettingsElevated(path string) error {
	if runtime.GOOS == "darwin" {
		script := fmt.Sprintf(`do shell script "rm -f '%s'" with administrator privileges`, path)
		return hideCmd("osascript", "-e", script).Run()
	}
	return os.Remove(path)
}

// deleteOSEnvVar 非 Windows 无独立的 OS 级环境变量存储（来自 shell rc，已单独清），空实现。
func deleteOSEnvVar(scope string) error { return nil }

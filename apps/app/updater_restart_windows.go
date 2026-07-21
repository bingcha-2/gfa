//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// scheduleRestartAfterExit 启动隐藏的 PowerShell 辅助进程。辅助进程会等当前
// GFA 进程释放单实例 Mutex 后再拉起新版，避免更新重启被误判成重复启动。
func scheduleRestartAfterExit(exePath string) error {
	pid := os.Getpid()
	workingDir := filepath.Dir(exePath)
	ps := fmt.Sprintf(
		"$ErrorActionPreference='SilentlyContinue'; Wait-Process -Id %d; Start-Process -FilePath '%s' -WorkingDirectory '%s'",
		pid,
		powerShellSingleQuote(exePath),
		powerShellSingleQuote(workingDir),
	)
	return hideCmd("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps).Start()
}

func powerShellSingleQuote(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

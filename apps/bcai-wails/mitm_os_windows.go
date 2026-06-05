//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Windows 下接管 Claude 桌面端：
//   - 无需装系统 CA —— Code/Cowork 的 Node 子进程靠重启注入的 NODE_EXTRA_CA_CERTS
//     即信任 MITM 证书；
//   - Windows 无 macOS 的 LaunchServices/TCC 限制，直接 exec 二进制带 env 即可，
//     子进程默认继承父进程环境（参考 reclaude cmd/launcher）。

func mitmInstallCA(certPath string) error { return nil }
func mitmUninstallCA() error              { return nil }
func mitmIsCAInstalled() bool             { return false }

func detectClaudeDesktopPath() string {
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		if m, _ := filepath.Glob(filepath.Join(pf, "WindowsApps", "Claude_*", "app", "Claude.exe")); len(m) > 0 {
			return m[len(m)-1] // 取最新版本
		}
	}
	for _, c := range []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Claude", "Claude.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "claude-desktop", "Claude.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Claude", "Claude.exe"),
	} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func mitmKillClaudeWindows() {
	_ = exec.Command("taskkill", "/IM", "Claude.exe", "/F").Run()
	time.Sleep(2 * time.Second)
}

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string) error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	mitmKillClaudeWindows()
	cmd := exec.Command(bin)
	cmd.Env = mitmProxyEnv(os.Environ(), proxyAddr, caCertPath)
	return cmd.Start()
}

func mitmRelaunchClaudePlain() error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	mitmKillClaudeWindows()
	return exec.Command(bin).Start()
}

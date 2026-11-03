//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func detectClaudeDesktopPathAuto() string {
	la := os.Getenv("LOCALAPPDATA")
	pf := os.Getenv("ProgramFiles")

	// ── 策略 1/3/4: 纯文件系统定位(跨平台可单测,见 claude_desktop_detect.go) ──
	if p := claudeDesktopFromDirs(la, pf); p != "" {
		return p
	}

	// ── 策略 2: 注册表 InstallLocation(自定义路径/企业分发);HKCU 优先,HKLM 兜底
	// (per-machine 安装写在 HKLM,含 WOW6432Node 32 位视图)。 ──
	for _, key := range []string{
		`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
	} {
		loc := registryReadValue(key, "InstallLocation")
		if loc == "" {
			continue
		}
		// InstallLocation 指向安装根目录;同样支持根 exe 与 app-* 版本子目录。
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if exe := filepath.Join(loc, name); statIsFile(exe) {
				return exe
			}
		}
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if m, _ := filepath.Glob(filepath.Join(loc, "app-*", name)); len(m) > 0 {
				return m[len(m)-1]
			}
		}
	}

	// ── 策略 5: 运行进程嗅探(最后兜底,仅 Claude 正在运行时有效) ──
	if out, err := hideCmd("wmic", "process", "where",
		"name='claude.exe'", "get", "ExecutablePath", "/value").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "ExecutablePath=") {
				if p := strings.TrimSpace(strings.TrimPrefix(line, "ExecutablePath=")); p != "" {
					return p
				}
			}
		}
	}

	return ""
}

func stopClaudeDesktop() {
	// hideCmd：taskkill 否则会闪一个控制台黑框(本进程是 GUI Wails app)。
	_ = hideCmd("taskkill", "/IM", "Claude.exe", "/F").Run()
	time.Sleep(2 * time.Second)
}

func startClaudeDesktop() error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	if isMicrosoftStoreClaude(bin) {
		// 原生 3P 配置全在文件里,不需要往进程注入 env/argv,可以按包激活启动。
		// MSIX 会在进程内缓存 deploymentMode,必须是完整重启(stopClaudeDesktop 已结束进程)。
		aumid := msixAppUserModelID(bin)
		if aumid == "" {
			return fmt.Errorf("无法识别 Microsoft Store 版 Claude Desktop 的包标识,请手动重启")
		}
		return exec.Command("explorer.exe", `shell:AppsFolder\`+aumid).Start()
	}
	return exec.Command(bin).Start()
}

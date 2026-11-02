//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const legacyClaudeBinary = "/Applications/Claude.app/Contents/MacOS/Claude"

func detectClaudeDesktopPathAuto() string {
	candidates := []string{"/Applications/Claude.app"}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates, filepath.Join(home, "Applications", "Claude.app"))
	}
	for _, app := range candidates {
		if _, err := os.Stat(app); err == nil {
			return app
		}
	}
	return ""
}

func stopClaudeDesktop() {
	_ = exec.Command("osascript", "-e", `quit app "Claude"`).Run()
	// 兜底强杀（quit 可能被未保存对话拦下）。
	_ = exec.Command("pkill", "-9", "-f", legacyClaudeBinary).Run()
	// 给退出留点时间，避免随后的 open 命中正在退出的旧实例。
	time.Sleep(2 * time.Second)
}

func startClaudeDesktop() error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未检测到 Claude Desktop")
	}
	return exec.Command("open", "-a", bin).Run()
}

//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// macOS 下的 OS 副作用：装/卸根 CA（系统钥匙串信任）、退出并带代理 env 重启 Claude.app。
// 注意：security add/delete-trusted-cert 改系统信任库需管理员权限；在真实 GUI App 里用
// osascript "with administrator privileges" 会弹出原生密码框（agent 无头环境弹不出，故只能真机验证）。

const mitmClaudeAppBinary = "/Applications/Claude.app/Contents/MacOS/Claude"

func mitmInstallCA(certPath string) error {
	if _, err := os.Stat(certPath); err != nil {
		return fmt.Errorf("CA cert not found: %s", certPath)
	}
	script := fmt.Sprintf(
		`do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '%s'" with administrator privileges`,
		certPath,
	)
	if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("add-trusted-cert: %v: %s", err, string(out))
	}
	return nil
}

func mitmUninstallCA() error {
	script := fmt.Sprintf(
		`do shell script "security delete-certificate -c '%s' /Library/Keychains/System.keychain" with administrator privileges`,
		mitmCACommonName,
	)
	if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("delete-certificate: %v: %s", err, string(out))
	}
	return nil
}

func mitmIsCAInstalled() bool {
	// 钥匙串里存在该 CN 即视为已装（信任与否另算；这里只做安装态指示）。
	err := exec.Command("security", "find-certificate", "-c", mitmCACommonName,
		"/Library/Keychains/System.keychain").Run()
	return err == nil
}

func mitmClaudeBinaryPath() string { return mitmClaudeAppBinary }

// detectClaudeDesktopPath 返回 Claude 桌面端安装路径（未装则空）。
func detectClaudeDesktopPath() string {
	const app = "/Applications/Claude.app"
	if _, err := os.Stat(app); err == nil {
		return app
	}
	return ""
}

func mitmQuitClaude() {
	_ = exec.Command("osascript", "-e", `quit app "Claude"`).Run()
	// 兜底强杀（quit 可能被未保存对话拦下）。
	_ = exec.Command("pkill", "-9", "-f", mitmClaudeAppBinary).Run()
}

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string) error {
	bin := mitmClaudeBinaryPath()
	if _, err := os.Stat(bin); err != nil {
		return fmt.Errorf("Claude.app not found at %s", bin)
	}
	mitmQuitClaude()
	cmd := exec.Command(bin)
	cmd.Env = mitmProxyEnv(os.Environ(), proxyAddr, caCertPath)
	return cmd.Start()
}

func mitmRelaunchClaudePlain() error {
	mitmQuitClaude()
	return exec.Command("open", "-a", "Claude").Start()
}

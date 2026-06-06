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

// Windows 下接管 Claude 桌面端：
//   - Code/Cowork 的 Node 子进程：靠重启注入的 NODE_EXTRA_CA_CERTS 即信任 MITM 证书，
//     不依赖系统证书库；
//   - 但桌面端 Chromium UI(登录页/升级墙/claude.ai 订阅改写)只信【系统证书库】，
//     不读 NODE_EXTRA_CA_CERTS。要让 entitlement/付费墙改写够得着 Chromium 侧，必须把
//     根 CA 装进「受信任的根证书颁发机构」，否则 Chromium 对 MITM 叶证书报
//     NET::ERR_CERT_AUTHORITY_INVALID、聊天/升级墙整页打不开。
//
// 装进 CurrentUser\Root(`certutil -user`)而非 LocalMachine：免管理员/UAC，Chromium
// (Electron)同样信任当前用户根存储。首次安装 Windows 会弹一次「安全警告 / 是否安装此
// 证书」确认框(与 macOS 弹一次管理员授权对应)；已装则 mitmIsCAInstalled 跳过，不再弹。
//
// Windows 无 macOS 的 LaunchServices/TCC 限制，直接 exec 二进制带 env 即可，子进程默认
// 继承父进程环境（参考 reclaude cmd/launcher）。

// argv 构造与输出判定抽在 mitm_ca_certutil.go(纯逻辑,跨平台单测覆盖);此处只负责
// 执行 certutil(hideCmd 防黑框)并把结果接回去。

func mitmInstallCA(certPath string) error {
	if _, err := os.Stat(certPath); err != nil {
		return fmt.Errorf("CA cert not found: %s", certPath)
	}
	out, err := hideCmd("certutil", certutilAddRootArgs(certPath)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("certutil -addstore Root: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func mitmUninstallCA() error {
	out, err := hideCmd("certutil", certutilDelRootArgs(mitmCACommonName)...).CombinedOutput()
	if err != nil && !certutilDeleteErrBenign(out) {
		return fmt.Errorf("certutil -delstore Root: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func mitmIsCAInstalled() bool {
	out, err := hideCmd("certutil", certutilQueryRootArgs(mitmCACommonName)...).CombinedOutput()
	return certutilQueryShowsCA(out, err, mitmCACommonName)
}

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
	// hideCmd：taskkill 否则会闪一个控制台黑框(本进程是 GUI Wails app)。
	_ = hideCmd("taskkill", "/IM", "Claude.exe", "/F").Run()
	time.Sleep(2 * time.Second)
}

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string) error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	mitmKillClaudeWindows()
	// 启动 Claude.exe 用裸 exec.Command：它是 GUI 进程，不能用 hideCmd(HideWindow 会把
	// 主窗口一起隐藏)。
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

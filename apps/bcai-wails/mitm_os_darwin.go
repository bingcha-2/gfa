//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
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

// mitmCleanupLegacyUserCA 仅 Windows 有「当前用户库」迁移问题;macOS 走系统钥匙串,无需清理。
func mitmCleanupLegacyUserCA() error { return nil }

func mitmIsCAInstalled() bool {
	// 必须是「受信任根」，不能只是「存在于钥匙串」——Chromium/Safari 只信任设置里的根，
	// 仅存在但未设信任会导致 TLS 握手 "unknown certificate"。且必须比对【当前 ca.crt 的指纹】:
	// 仅比 CN 会被同名孤儿根骗过(CA 重生成后旧根还在 → 误判已装 → 当前叶证书验不过 → 白屏)。
	tp, err := mitmCASHA1FromFile(mitmCACertPath())
	if err != nil || tp == "" {
		return false
	}
	// ① CN 是否被设为受信根(dump-trust-settings -d 在无任何 admin 信任设置时返回非 0 = 未装)。
	dump, derr := exec.Command("security", "dump-trust-settings", "-d").CombinedOutput()
	if derr != nil {
		return false
	}
	// ② 钥匙串里是否存在指纹 == 当前 ca.crt 的同名证书(-Z 打印 SHA-1)。
	find, _ := exec.Command("security", "find-certificate", "-a", "-Z",
		"-c", mitmCACommonName, "/Library/Keychains/System.keychain").CombinedOutput()
	return mitmDarwinThumbprintInstalled(string(find), string(dump), tp, mitmCACommonName)
}

func mitmClaudeBinaryPath() string { return mitmClaudeAppBinary }

// detectClaudeDesktopPathAuto 自动检测 Claude 桌面端安装路径（未装则空）。
// 与运行状态无关:装了就能检测到。先查系统 /Applications,再查用户级 ~/Applications。
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

const mitmClaudeAppPath = "/Applications/Claude.app"

func mitmQuitClaude() {
	_ = exec.Command("osascript", "-e", `quit app "Claude"`).Run()
	// 兜底强杀（quit 可能被未保存对话拦下）。
	_ = exec.Command("pkill", "-9", "-f", mitmClaudeAppBinary).Run()
	// 给退出留点时间，避免随后的 open 命中正在退出的旧实例。
	time.Sleep(2 * time.Second)
}

// mitmRelaunchClaudeWithProxy 经 LaunchServices(`open`)重启 Claude.app，注入代理。必须走
// `open` 而非直接 exec 二进制——后者会绕过 LaunchServices，使 Claude 失去 TCC 授权。
//
// 两条代理通道一起注入：
//   - --env HTTPS_PROXY 等：给 Code/Cowork 的 Node 子进程(它只认 env)。
//   - --args --proxy-server：给 Chromium 渲染进程(登录页/升级墙/主聊天，它不认 env、只认
//     Chromium 命令行 flag)。要掀翻 Chromium 侧的付费墙必须走这条；前提是根 CA 已装进
//     系统钥匙串(由 RelaunchClaudeWithProxy 在调用本函数前确保)，否则 Chromium 不信 MITM 证书。
//   - --proxy-bypass-list：放行 localhost，避免 Chromium 把本机回环也代理掉。
func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string, chromiumProxy bool) error {
	if _, err := os.Stat(mitmClaudeAppPath); err != nil {
		return fmt.Errorf("Claude.app not found at %s", mitmClaudeAppPath)
	}
	mitmQuitClaude()
	args := []string{"-a", mitmClaudeAppPath}
	for _, kv := range mitmProxyEnvPairs(proxyAddr, caCertPath) {
		args = append(args, "--env", kv)
	}
	// --args 之后的都传给 App(Chromium 读取);务必排在所有 --env 之后。
	// 仅当根 CA 确被信任(chromiumProxy)才给 Chromium 加 --proxy-server;否则 claude.ai(UI 主站)
	// 被 MITM 却信不过叶证书会整页报错白屏 —— 此时只走 env(Node 推理),Chromium 直连。
	if chromiumProxy {
		args = append(args, "--args",
			"--proxy-server="+proxyAddr,
			"--proxy-bypass-list=127.0.0.1,localhost",
		)
	}
	return exec.Command("open", args...).Run()
}

func mitmRelaunchClaudePlain() error {
	mitmQuitClaude()
	return exec.Command("open", "-a", mitmClaudeAppPath).Run()
}

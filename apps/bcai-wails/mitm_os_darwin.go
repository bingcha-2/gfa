//go:build darwin

package main

import (
	"context"
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

// mitmInstallCA 走 admin/系统域 → 用户域 的降级阶梯(对齐 Windows 的 LocalMachine→CurrentUser):
//   - 首选 admin 域(osascript 提权 + System 钥匙串):全进程一律信任,Chromium 必认。
//   - admin 域那步内部的 SecTrustSettingsSetTrustSettings 需一道独立的 com.apple.trust-settings.admin
//     授权;提权出来、脱离 GUI 会话的 root 子进程在远程会话/受管 Mac 上弹不出它 →
//     "The authorization was denied since no user interaction was possible" → 降级用户域。
//   - 用户域(不带 -d、落 login 库)免管理员、免那道二次授权;macOS 的 SecTrustEvaluate 合并
//     user+admin+system 域,Chromium 同样认 → 仍能掀付费墙显示 Max。两域都失败才 caInstallFailed。
//
// 编排细节(含"返回非零但信任已落盘"的复核)见 decideCAInstall,纯逻辑、可单测。
func mitmInstallCA(certPath string) (caInstallResult, error) {
	if _, err := os.Stat(certPath); err != nil {
		return caInstallFailed, fmt.Errorf("CA cert not found: %s", certPath)
	}
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) {
			out, e := exec.Command("osascript", "-e", securityAddTrustedCertAdminScript(certPath)).CombinedOutput()
			if e != nil && securityAuthInteractionDenied(string(out)) {
				Log("[mitm] admin 域设信任的二次授权框无法弹出(远程会话/受管 Mac 常见),降级用户域…")
			}
			return string(out), e
		},
		verifyMachine:    mitmCAVerifyTrusted,
		skipUserFallback: securityAuthUserCanceled,
		installUser: func() (string, error) {
			out, e := exec.Command("security", securityAddTrustedCertUserArgs(certPath)...).CombinedOutput()
			return string(out), e
		},
		verifyUser: mitmCAVerifyTrusted,
	})
	if err != nil {
		return res, fmt.Errorf("add-trusted-cert: %w", err)
	}
	if res == caInstalledUser {
		Log("[mitm] 根 CA 已降级安装到当前用户信任域(免管理员;是否显示 Max 待重启前 verify-cert 轮询确认)")
	}
	return res, nil
}

func mitmUninstallCA() error {
	// 用户域降级安装可能把信任 + 证书落在当前用户 login 库,免管理员先 best-effort 清掉
	// (remove-trusted-cert 撤用户域信任设置;delete-certificate 删 login 库里的同名证书)。
	_ = exec.Command("security", "remove-trusted-cert", mitmCACertPath()).Run()
	_, _ = exec.Command("security", "delete-certificate", "-c", mitmCACommonName).CombinedOutput()
	// admin/System 域:删证书 + 撤 admin 信任需管理员授权。
	script := fmt.Sprintf(
		`do shell script "security delete-certificate -c '%s' /Library/Keychains/System.keychain" with administrator privileges`,
		mitmCACommonName,
	)
	if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("delete-certificate: %v: %s", err, string(out))
	}
	return nil
}

// mitmCleanupLegacyUserCA macOS 历史上一直走系统钥匙串,从无「遗留用户库孤儿根」迁移问题;
// 9.x 起新增的用户域降级是当前机制、由 mitmCAInUserStore 守护,不属于"遗留",故仍无需清理。
func mitmCleanupLegacyUserCA() error { return nil }

// mitmCAVerifyTrusted 问系统"当前 ca.crt 现在到底受不受信"——【权威】判定:verify-cert 跑的就是
// Chromium/Safari 用的 SecTrustEvaluate,合并 user+admin+system 三域、按证书指纹(非 CN)判定,
// 跨 macOS 版本与各种残留态(装一半 / 0 条信任设置 / 同名孤儿根)都一致。取代按 dump-trust-settings
// 文本推断信任的脆弱做法。带超时兜底,避免极端情况下 verify-cert 卡住阻塞接管。
func mitmCAVerifyTrusted() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "security", securityVerifyCertArgs(mitmCACertPath())...).CombinedOutput()
	return securityVerifyCertTrusted(string(out), err)
}

// mitmIsCAInstalled 当前 ca.crt 是否真受信。直接用 verify-cert 的权威结果 —— 这正是 chromiumProxy
// 闸门(决定是否给 Claude.app 加 --proxy-server)最该问的问题:Chromium 信不信我们的 MITM 叶证书。
func mitmIsCAInstalled() bool {
	return mitmCAVerifyTrusted()
}

// mitmCATrustedInDomain 按 dump-trust-settings + find-certificate 判定某【单个域】是否受信。
// 注意:已不再用于"是否受信"的主判定(那走权威的 mitmCAVerifyTrusted);仅 mitmCAInUserStore
// 还用它喂跨平台的清理守护(darwin 的 mitmCleanupLegacyUserCA 是 no-op,故其精度无关紧要)。
func mitmCATrustedInDomain(adminDomain bool, keychain string) bool {
	tp, err := mitmCASHA1FromFile(mitmCACertPath())
	if err != nil || tp == "" {
		return false
	}
	dump, derr := exec.Command("security", securityDumpTrustSettingsArgs(adminDomain)...).CombinedOutput()
	if derr != nil {
		return false
	}
	find, _ := exec.Command("security", securityFindCertArgs(mitmCACommonName, keychain)...).CombinedOutput()
	return mitmDarwinThumbprintInstalled(string(find), string(dump), tp, mitmCACommonName)
}

// mitmCAInUserStore 当前 ca.crt 是否在用户域受信(login 库)。仅供跨平台清理守护
// (mitm_manager.go 的 caResult != caInstalledUser && !mitmCAInUserStore())调用;darwin 的
// 清理本身是 no-op,故此处返回值不影响任何实际副作用。"是否受信"的权威判定见 mitmCAVerifyTrusted。
func mitmCAInUserStore() bool {
	return mitmCATrustedInDomain(false, "")
}

// mitmOpenCACertForTrust 用「钥匙串访问」打开当前 ca.crt,让用户手动把它设为"始终信任"。
// 仅用于自动安装(admin + 用户域)都失败后的【一键兜底】:macOS 不允许程序静默信任根 CA,但能
// 替用户把证书直接在钥匙串里打开,省掉找隐藏目录 ~/.bcai + ⌘⇧G 的导航。授权那一下 macOS 不让省。
func mitmOpenCACertForTrust() error {
	cert := mitmCACertPath()
	if _, err := os.Stat(cert); err != nil {
		return fmt.Errorf("CA cert not found: %s", cert)
	}
	return exec.Command("open", openKeychainCertArgs(cert)...).Run()
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
//     系统钥匙串(由 InstallTakeoverCA 在调用本函数前确保)，否则 Chromium 不信 MITM 证书。
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

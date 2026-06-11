package main

import (
	"fmt"
	"strings"
)

// ─── macOS `security` 子命令构造 + 安装阶梯(纯逻辑,跨平台可单测)──────────────
//
// 真实 `security` / `osascript` 仅 macOS 有、且会真改信任库 + 弹授权框,故把
// "命令长什么样""错误怎么解读""装失败怎么降级"从 mitm_os_darwin.go 抽出来,在 host/CI
// 上锁住行为。OS 侧只负责把这些字符串/argv 喂给 exec 并把输出回灌。

// securityAddTrustedCertAdminScript 构造把根 CA 装进【admin 信任域 + System 钥匙串】的
// osascript 脚本(需管理员授权,会弹密码框)。admin 域是首选:所有用户/进程上下文一律信任,
// Chromium 必认。代价是它内部的 SecTrustSettingsSetTrustSettings 还需一道独立的
// com.apple.trust-settings.admin 授权,脱离 GUI 会话的提权子进程可能弹不出 → 失败时降级用户域。
func securityAddTrustedCertAdminScript(certPath string) string {
	return fmt.Sprintf(
		`do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '%s'" with administrator privileges`,
		certPath,
	)
}

// securityAddTrustedCertUserArgs 构造把根 CA 装进【用户信任域】的 `security` argv ——
// 不带 -d(security 默认即用户域)、不指定 System 钥匙串(落当前用户默认 login 库),
// 免管理员、免那道 admin 二次授权。这是 admin 路径失败的降级兜底,等价于 Windows 的
// certutil -user。macOS 的 SecTrustEvaluate 会合并 user+admin+system 域,故 Chromium 同样认。
func securityAddTrustedCertUserArgs(certPath string) []string {
	return []string{"add-trusted-cert", "-r", "trustRoot", certPath}
}

// securityDumpTrustSettingsArgs 构造 dump-trust-settings 的 argv:adminDomain=true → -d(admin 域);
// false → 无 flag(用户域,security 的默认)。注:dump-trust-settings 无 -u,默认就是用户域。
func securityDumpTrustSettingsArgs(adminDomain bool) []string {
	if adminDomain {
		return []string{"dump-trust-settings", "-d"}
	}
	return []string{"dump-trust-settings"}
}

// securityFindCertArgs 构造 find-certificate -a -Z -c <CN> [keychain] 的 argv。
// keychain 为空 → 不指定钥匙串(走当前用户搜索列表,含 login 库),用于用户域判定;
// 指定 System.keychain → 用于 admin/本机域判定。
func securityFindCertArgs(commonName, keychain string) []string {
	args := []string{"find-certificate", "-a", "-Z", "-c", commonName}
	if keychain != "" {
		args = append(args, keychain)
	}
	return args
}

// securityAuthInteractionDenied 判定 add-trusted-cert 的输出是否为"授权框弹不出"
// (errAuthorizationInteractionNotAllowed)—— 远程会话/受管 Mac/脱离 GUI 会话的 root 子进程
// 设 admin 信任时常见。区别于安全软件拦截/用户主动取消,便于上层给对症提示。
func securityAuthInteractionDenied(out string) bool {
	return strings.Contains(out, "The authorization was denied since no user interaction was possible")
}

// securityAuthUserCanceled 判定 add-trusted-cert 的输出是否为"用户主动取消授权框"
// (osascript 报 -128 / 用户已取消;security 报 "canceled by the user")。区别于"弹不出框":
// 用户既然亲手点了取消,就别再降级用户域去弹第二个框徒增烦扰 —— 用户域降级是为"弹不出/被策略拒"
// 准备的,不是为"用户主动拒绝"。
func securityAuthUserCanceled(out string) bool {
	low := strings.ToLower(out)
	return strings.Contains(out, "用户已取消") ||
		strings.Contains(low, "(-128)") ||
		strings.Contains(low, "canceled by the user") ||
		strings.Contains(low, "cancelled by the user") ||
		strings.Contains(low, "user canceled") ||
		strings.Contains(low, "user cancelled")
}

// securityVerifyCertArgs 构造 `security verify-cert -c <cert> -p ssl` 的 argv。
// 这是判断"根是否真受信"的【权威】方式:跑的就是 Chromium/Safari 用的 SecTrustEvaluate,
// 合并 user+admin+system 三域、按证书指纹(非 CN)判定,跨 macOS 版本/各种残留态都一致 ——
// 取代按 dump-trust-settings 文本推断信任的脆弱做法(后者会因机器状态而异)。
func securityVerifyCertArgs(certPath string) []string {
	return []string{"verify-cert", "-c", certPath, "-p", "ssl"}
}

// securityVerifyCertTrusted 解读 verify-cert 结果:退出码 0(err==nil)且输出含
// "certificate verification successful" 才算受信。两者都要 —— 任一不满足即判未受信,
// 把不确定性偏向"未受信"(退回 env-only 顶多没 Max,绝不误开 --proxy-server 导致白屏)。
func securityVerifyCertTrusted(out string, err error) bool {
	if err != nil {
		return false
	}
	return strings.Contains(out, "certificate verification successful")
}

// openKeychainCertArgs 构造用「钥匙串访问」打开证书的 `open` argv(让用户手动设"始终信任")。
// macOS 不允许程序静默信任根 CA(防恶意软件 —— 任何 App 都一样),故自动安装失败时退而求其次:
// 一键把证书直接在钥匙串里打开,省掉用户找隐藏目录(~/.bcai)+ ⌘⇧G 的导航。-a 强制用「钥匙串访问」
// 打开,避免 .crt 默认关联被改后打不开。
func openKeychainCertArgs(certPath string) []string {
	return []string{"-a", "Keychain Access", certPath}
}

// chromiumProxyDecision 决定带代理重启时是否给 Chromium 加 --proxy-server(掀 claude.ai 付费墙)。
//   - caInstalledMachine(admin/系统域):Chromium 必认,直接开,无需再等 verify。
//   - 其它(用户域降级 / 兜底):必须 verifyTrusted 真为 true 才开 —— 用户域是否被 Chromium 认不确定,
//     不敢盲信;verifyTrusted 由调用方【轮询 verify-cert】得到(给 trustd 留刷新时间,修"刚装完误报未受信")。
//
// 安全不变量:不确定就不开代理,宁可没 Max,绝不让 claude.ai 被 MITM 却验不过叶证书 → 整页白屏。
func chromiumProxyDecision(caResult caInstallResult, verifyTrusted bool) bool {
	if caResult == caInstalledMachine {
		return true
	}
	return verifyTrusted
}

// caInstallSteps 把"装本机/admin 域、复核、装用户域、复核"四个 OS 副作用抽成可注入的函数,
// 让降级阶梯 decideCAInstall 能在不真改信任库的前提下被单测。
type caInstallSteps struct {
	installMachine func() (string, error)
	verifyMachine  func() bool
	// skipUserFallback 在 machine 失败后判断是否【跳过】用户域降级(true=跳过,直接 caInstallFailed)。
	// 用于"admin 被用户明确取消 → 不再弹第二个框"。nil 表示从不跳过(保持原降级行为)。
	skipUserFallback func(machineOut string) bool
	installUser      func() (string, error)
	verifyUser       func() bool
}

// decideCAInstall 跑 admin/本机域 → 用户域 的降级阶梯(对齐 Windows 的 LocalMachine→CurrentUser):
// 纯编排,OS 副作用全部注入。
//
//   - admin 装成功 → caInstalledMachine,绝不再碰用户域(免无谓弹框/副作用)。
//   - admin 返回非零但信任已落盘(提权子进程设 admin 信任的已知坑:写进去了却仍报错)→
//     verifyMachine 复核为真即按 caInstalledMachine 收,同样不降级。
//   - admin 确未落盘 → 降级用户域;装成功(或返回非零但 verifyUser 复核已落盘)→ caInstalledUser。
//   - 两域都失败 → caInstallFailed,错误同时点名两域输出便于排查。
func decideCAInstall(s caInstallSteps) (caInstallResult, error) {
	mOut, mErr := s.installMachine()
	if mErr == nil || s.verifyMachine() {
		return caInstalledMachine, nil
	}
	// admin 被用户【明确取消】时不再降级用户域(否则又弹第二个框)—— 用户域降级是为
	// "弹不出框/被策略拒"准备的,不是为"用户主动拒绝"。
	if s.skipUserFallback != nil && s.skipUserFallback(mOut) {
		return caInstallFailed, fmt.Errorf("machine domain: %v: %s (用户取消,跳过用户域降级)", mErr, strings.TrimSpace(mOut))
	}
	uOut, uErr := s.installUser()
	if uErr == nil || s.verifyUser() {
		return caInstalledUser, nil
	}
	return caInstallFailed, fmt.Errorf(
		"machine domain: %v: %s; user domain: %v: %s",
		mErr, strings.TrimSpace(mOut), uErr, strings.TrimSpace(uOut),
	)
}

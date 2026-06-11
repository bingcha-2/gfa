package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// ─── macOS `security` 安装阶梯的纯逻辑单测,跨平台可跑 ──────────────────────────
//
// 根因:旧版 mitmInstallCA(darwin)只试 admin 信任域(osascript 提权 + -d)。该域的
// SecTrustSettingsSetTrustSettings 需一道独立的 com.apple.trust-settings.admin 授权,
// 而 security_authtrampoline 拉起的 root 子进程脱离 GUI 会话弹不出它 →
// "The authorization was denied since no user interaction was possible" → 直接判死。
// Windows 侧本机库失败会降级当前用户库;macOS 却没有这一级 —— caInstalledUser 在 darwin
// 是死代码。本测试驱动出"admin 域失败 → 降级用户域(去掉 -d,免管理员)"的阶梯。

// admin 路径:必须带 -d(admin 域)、写 System 钥匙串、且经 osascript 提权。
func TestSecurityAddTrustedCertAdminScript_UsesAdminDomainAndElevation(t *testing.T) {
	script := securityAddTrustedCertAdminScript("/Users/me/.bcai/mitm/ca.crt")
	for _, want := range []string{
		"add-trusted-cert",
		"-d", // admin 域
		"-r trustRoot",
		"/Library/Keychains/System.keychain",
		"with administrator privileges",
		"/Users/me/.bcai/mitm/ca.crt",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("admin 脚本缺少 %q:\n%s", want, script)
		}
	}
}

// 用户域降级:绝不能带 -d(否则又回去撞 admin 二次授权)、不碰 System 钥匙串,但要 trustRoot 当前证书。
func TestSecurityAddTrustedCertUserArgs_OmitsAdminDomain(t *testing.T) {
	args := securityAddTrustedCertUserArgs("/Users/me/.bcai/mitm/ca.crt")
	if containsArg(args, "-d") {
		t.Errorf("用户域 args %v 不应带 -d(带 -d 会走 admin 域、再次要二次授权)", args)
	}
	if containsArg(args, "/Library/Keychains/System.keychain") {
		t.Errorf("用户域 args %v 不应碰 System 钥匙串", args)
	}
	if !containsArg(args, "add-trusted-cert") || !containsArg(args, "trustRoot") {
		t.Errorf("用户域 args %v 应是 add-trusted-cert ... trustRoot", args)
	}
	if !containsArg(args, "/Users/me/.bcai/mitm/ca.crt") {
		t.Errorf("用户域 args %v 应包含当前 ca.crt 路径", args)
	}
}

// dump-trust-settings:admin 域带 -d;用户域无 flag(security 默认)。
func TestSecurityDumpTrustSettingsArgs(t *testing.T) {
	admin := securityDumpTrustSettingsArgs(true)
	if !containsArg(admin, "dump-trust-settings") || !containsArg(admin, "-d") {
		t.Errorf("admin dump args = %v,应含 dump-trust-settings 与 -d", admin)
	}
	user := securityDumpTrustSettingsArgs(false)
	if !containsArg(user, "dump-trust-settings") {
		t.Errorf("user dump args = %v,应含 dump-trust-settings", user)
	}
	if containsArg(user, "-d") {
		t.Errorf("user dump args = %v 不应带 -d(否则查的是 admin 域)", user)
	}
}

// find-certificate:始终 -a -Z -c CN;指定 keychain 时附在末尾,空则省略(走搜索列表)。
func TestSecurityFindCertArgs(t *testing.T) {
	const cn = "BingchaAI Local Root"
	withKC := securityFindCertArgs(cn, "/Library/Keychains/System.keychain")
	for _, want := range []string{"find-certificate", "-a", "-Z", "-c", cn, "/Library/Keychains/System.keychain"} {
		if !containsArg(withKC, want) {
			t.Errorf("find(系统库) args %v 缺少 %q", withKC, want)
		}
	}
	noKC := securityFindCertArgs(cn, "")
	if containsArg(noKC, "/Library/Keychains/System.keychain") {
		t.Errorf("find(用户库) args %v 不该带任何系统钥匙串路径", noKC)
	}
	for _, want := range []string{"find-certificate", "-a", "-Z", "-c", cn} {
		if !containsArg(noKC, want) {
			t.Errorf("find(用户库) args %v 缺少 %q", noKC, want)
		}
	}
}

// 错误分类:精确命中 errAuthorizationInteractionNotAllowed,不误伤其它错误。
func TestSecurityAuthInteractionDenied(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want bool
	}{
		{"真实报错", "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible. (1)", true},
		{"用户主动取消不算", "User canceled.", false},
		{"安全软件拦截不算", "add-trusted-cert: SecTrustSettingsSetTrustSettings: write permission denied", false},
		{"空输出", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := securityAuthInteractionDenied(tt.out); got != tt.want {
				t.Fatalf("securityAuthInteractionDenied(%q) = %v, want %v", tt.out, got, tt.want)
			}
		})
	}
}

// verify-cert argv:权威信任判定走 verify-cert -c <cert> -p ssl(而非解析 dump 文本)。
func TestSecurityVerifyCertArgs(t *testing.T) {
	got := securityVerifyCertArgs("/Users/me/.bcai/mitm/ca.crt")
	want := []string{"verify-cert", "-c", "/Users/me/.bcai/mitm/ca.crt", "-p", "ssl"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("verify-cert args = %v, want %v", got, want)
	}
}

// verify-cert 结果解读。真值表来自真机实测(含"同 CN 不同 key 未受信"这一对抗样本):
//
//	受信根 → exit 0 + "certificate verification successful"
//	未受信(哪怕同 CN)→ exit 非 0,无成功文案
//
// 退出码与成功文案【都】满足才算受信;任一不满足偏向"未受信"(宁可没 Max,绝不误开代理白屏)。
func TestSecurityVerifyCertTrusted(t *testing.T) {
	tests := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"受信根(exit0+成功文案)", "...certificate verification successful.\n", nil, true},
		{"未受信(同 CN,exit 非0)", "CSSMERR_TP_NOT_TRUSTED\n", errFakeExit, false},
		{"退出码0但无成功文案(防御:不轻信)", "No extended validation result found\n", nil, false},
		{"有成功文案但 exit 非0(防御:退出码优先)", "certificate verification successful", errFakeExit, false},
		{"空输出", "", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := securityVerifyCertTrusted(tt.out, tt.err); got != tt.want {
				t.Fatalf("securityVerifyCertTrusted(%q, %v) = %v, want %v", tt.out, tt.err, got, tt.want)
			}
		})
	}
}

// chromiumProxy 闸门决策:系统域必开;用户域/兜底必须 verify 确认才开(防白屏)。
func TestChromiumProxyDecision(t *testing.T) {
	tests := []struct {
		name   string
		res    caInstallResult
		verify bool
		want   bool
	}{
		{"系统域:无需 verify 直接开", caInstalledMachine, false, true},
		{"系统域:verify 真也开", caInstalledMachine, true, true},
		{"用户域:verify 确认 → 开", caInstalledUser, true, true},
		{"用户域:verify 未确认 → 不开(防白屏)", caInstalledUser, false, false},
		{"失败但 verify 真(本来就装着)→ 开", caInstallFailed, true, true},
		{"失败且 verify 假 → 不开", caInstallFailed, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := chromiumProxyDecision(tt.res, tt.verify); got != tt.want {
				t.Fatalf("chromiumProxyDecision(%v, %v) = %v, want %v", tt.res, tt.verify, got, tt.want)
			}
		})
	}
}

// 一键打开证书信任:用「钥匙串访问」打开当前 ca.crt(自动安装失败的兜底,免去找隐藏目录)。
func TestOpenKeychainCertArgs(t *testing.T) {
	got := openKeychainCertArgs("/Users/me/.bcai/mitm/ca.crt")
	want := []string{"-a", "Keychain Access", "/Users/me/.bcai/mitm/ca.crt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("openKeychainCertArgs = %v, want %v", got, want)
	}
}

// 用户主动取消授权框的分类(osascript -128/用户已取消;security canceled by the user)。
// 真值表来自真机实测日志。区别于"弹不出框"(securityAuthInteractionDenied),也别误伤其它错误。
func TestSecurityAuthUserCanceled(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want bool
	}{
		{"osascript 中文取消", "0:163: execution error: 用户已取消。 (-128)", true},
		{"-128 码", "execution error: User cancelled. (-128)", true},
		{"security 英文取消", "SecTrustSettingsSetTrustSettings: The authorization was canceled by the user.", true},
		{"弹不出框不算取消", "The authorization was denied since no user interaction was possible.", false},
		{"安全软件拦截不算", "write permission denied", false},
		{"空输出", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := securityAuthUserCanceled(tt.out); got != tt.want {
				t.Fatalf("securityAuthUserCanceled(%q) = %v, want %v", tt.out, got, tt.want)
			}
		})
	}
}

// admin 被用户【明确取消】→ 跳过用户域降级(不再弹第二个框),直接 caInstallFailed。
func TestDecideCAInstall_SkipUserFallbackOnCancel(t *testing.T) {
	userCalls := 0
	res, err := decideCAInstall(caInstallSteps{
		installMachine:   func() (string, error) { return "用户已取消。 (-128)", errors.New("exit status 1") },
		verifyMachine:    func() bool { return false },
		skipUserFallback: func(out string) bool { return true }, // 模拟"识别为取消"
		installUser:      func() (string, error) { userCalls++; return "", nil },
		verifyUser:       func() bool { return false },
	})
	if res != caInstallFailed || err == nil {
		t.Fatalf("= (%v, %v), want (caInstallFailed, non-nil)", res, err)
	}
	if userCalls != 0 {
		t.Fatalf("用户取消后绝不能再弹用户域框,实际调用 installUser %d 次", userCalls)
	}
}

// skipUserFallback 返回 false(或 nil)时仍走原降级 —— 不破坏"弹不出框"那条主修复。
func TestDecideCAInstall_SkipPredicateFalseStillFallsBack(t *testing.T) {
	res, err := decideCAInstall(caInstallSteps{
		installMachine:   func() (string, error) { return "no user interaction", errors.New("exit status 1") },
		verifyMachine:    func() bool { return false },
		skipUserFallback: func(out string) bool { return false },
		installUser:      func() (string, error) { return "", nil },
		verifyUser:       func() bool { return false },
	})
	if err != nil || res != caInstalledUser {
		t.Fatalf("= (%v, %v), want (caInstalledUser, nil)", res, err)
	}
}

// ── 降级阶梯 decideCAInstall ───────────────────────────────────────────────

// admin/本机域装成功 → caInstalledMachine,且【绝不】再去碰用户域(无谓副作用/弹框)。
func TestDecideCAInstall_MachineSuccessSkipsUser(t *testing.T) {
	userCalls := 0
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) { return "", nil },
		verifyMachine:  func() bool { t.Fatal("装成功不应再复核"); return false },
		installUser:    func() (string, error) { userCalls++; return "", nil },
		verifyUser:     func() bool { return false },
	})
	if err != nil || res != caInstalledMachine {
		t.Fatalf("= (%v, %v), want (caInstalledMachine, nil)", res, err)
	}
	if userCalls != 0 {
		t.Fatalf("本机域成功后不应尝试用户域,实际调用 %d 次", userCalls)
	}
}

// admin 返回非零但信任已落盘(verifyMachine=true)→ caInstalledMachine,不降级用户域。
func TestDecideCAInstall_MachineNonZeroButTrusted(t *testing.T) {
	userCalls := 0
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) { return "exit 1", errors.New("exit status 1") },
		verifyMachine:  func() bool { return true },
		installUser:    func() (string, error) { userCalls++; return "", nil },
		verifyUser:     func() bool { return false },
	})
	if err != nil || res != caInstalledMachine {
		t.Fatalf("= (%v, %v), want (caInstalledMachine, nil)", res, err)
	}
	if userCalls != 0 {
		t.Fatalf("信任已落盘不应降级用户域,实际调用 %d 次", userCalls)
	}
}

// admin 失败(授权弹不出,且确未落盘)→ 降级用户域装成功 → caInstalledUser。
func TestDecideCAInstall_FallsBackToUserDomain(t *testing.T) {
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) {
			return "The authorization was denied since no user interaction was possible.", errors.New("exit status 1")
		},
		verifyMachine: func() bool { return false },
		installUser:   func() (string, error) { return "", nil },
		verifyUser:    func() bool { return true },
	})
	if err != nil || res != caInstalledUser {
		t.Fatalf("= (%v, %v), want (caInstalledUser, nil)", res, err)
	}
}

// 用户域命令返回非零但信任已落盘(verifyUser=true)→ 仍算 caInstalledUser。
func TestDecideCAInstall_UserNonZeroButTrusted(t *testing.T) {
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) { return "", errors.New("exit status 1") },
		verifyMachine:  func() bool { return false },
		installUser:    func() (string, error) { return "weird", errors.New("exit status 1") },
		verifyUser:     func() bool { return true },
	})
	if err != nil || res != caInstalledUser {
		t.Fatalf("= (%v, %v), want (caInstalledUser, nil)", res, err)
	}
}

// admin + 用户域都失败 → caInstallFailed,且错误信息要同时点名两个域(便于排查)。
func TestDecideCAInstall_BothFail(t *testing.T) {
	res, err := decideCAInstall(caInstallSteps{
		installMachine: func() (string, error) { return "admin boom", errors.New("exit status 1") },
		verifyMachine:  func() bool { return false },
		installUser:    func() (string, error) { return "user boom", errors.New("exit status 1") },
		verifyUser:     func() bool { return false },
	})
	if res != caInstallFailed || err == nil {
		t.Fatalf("= (%v, %v), want (caInstallFailed, non-nil)", res, err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "admin boom") || !strings.Contains(msg, "user boom") {
		t.Fatalf("错误信息应同时含两域输出,got: %s", msg)
	}
}

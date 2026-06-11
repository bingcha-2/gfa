package main

import (
	"strings"
	"testing"
)

// ─── 接管分级提示按平台拆分的纯逻辑单测,跨平台可跑 ────────────────────────────
//
// 背景:CA_DEGRADED / CA_FAILED 文案曾 Win/Mac 共用,混着两边的操作词(右键管理员运行 vs
// 物理屏幕/钥匙串),对谁都不完全对。尤其 macOS 没有"以管理员身份运行 App",且证书在隐藏目录
// ~/.bcai 里没法直接双击。这里锁死:各平台只出现自己适用的操作词。

// macOS 专属词,绝不该出现在 Windows 文案里。
var macOnlyTokens = []string{"钥匙串", "物理屏幕"}

// Windows 专属词,绝不该出现在 macOS 文案里(macOS 无"右键/以管理员身份运行 App""UAC")。
var winOnlyTokens = []string{"右键", "以管理员身份", "UAC"}

func TestCaTakeoverHint_FailedIsPlatformSpecific(t *testing.T) {
	win := caTakeoverHint("windows", caInstallFailed)
	mac := caTakeoverHint("darwin", caInstallFailed)

	if !strings.HasPrefix(win, "CA_FAILED:") || !strings.HasPrefix(mac, "CA_FAILED:") {
		t.Fatalf("两平台都应保留 CA_FAILED: 前缀\nwin=%q\nmac=%q", win, mac)
	}
	// 都不该再自称"接管成功"(推理虽 OK 但证书没装、Max 没出来,自称成功是自相矛盾)。
	if strings.Contains(win, "接管成功") || strings.Contains(mac, "接管成功") {
		t.Errorf("CA_FAILED 不该自称『接管成功』(证书没装上)\nwin=%q\nmac=%q", win, mac)
	}
	// Windows 文案:给"管理员身份运行"这个 Windows 正确解法,不准漏 macOS 词。
	if !strings.Contains(win, "管理员") {
		t.Errorf("Windows CA_FAILED 应提示以管理员身份运行,got:\n%s", win)
	}
	for _, tok := range macOnlyTokens {
		if strings.Contains(win, tok) {
			t.Errorf("Windows CA_FAILED 不该出现 macOS 专属词 %q,got:\n%s", tok, win)
		}
	}
	// macOS 文案:首选"重新接管装证书"(点了弹密码框),并保留钥匙串手动兜底;不准出现 Windows 词。
	if !strings.Contains(mac, "重新接管") {
		t.Errorf("macOS CA_FAILED 应首选引导『重新接管装证书』,got:\n%s", mac)
	}
	if !strings.Contains(mac, "钥匙串") {
		t.Errorf("macOS CA_FAILED 应保留钥匙串手动兜底,got:\n%s", mac)
	}
	for _, tok := range winOnlyTokens {
		if strings.Contains(mac, tok) {
			t.Errorf("macOS CA_FAILED 不该出现 Windows 专属词 %q(Mac 无此操作),got:\n%s", tok, mac)
		}
	}
}

func TestCaTakeoverHint_DegradedIsPlatformSpecific(t *testing.T) {
	win := caTakeoverHint("windows", caInstalledUser)
	mac := caTakeoverHint("darwin", caInstalledUser)

	if !strings.HasPrefix(win, "CA_DEGRADED:") || !strings.HasPrefix(mac, "CA_DEGRADED:") {
		t.Fatalf("两平台都应保留 CA_DEGRADED: 前缀\nwin=%q\nmac=%q", win, mac)
	}
	for _, tok := range macOnlyTokens {
		if strings.Contains(win, tok) {
			t.Errorf("Windows CA_DEGRADED 不该出现 macOS 专属词 %q,got:\n%s", tok, win)
		}
	}
	for _, tok := range winOnlyTokens {
		if strings.Contains(mac, tok) {
			t.Errorf("macOS CA_DEGRADED 不该出现 Windows 专属词 %q,got:\n%s", tok, mac)
		}
	}
}

// 装进本机/系统域(最优)→ 不带 CA_ 前缀的成功提示,与平台无关。
func TestCaTakeoverHint_MachineSuccessNoWarning(t *testing.T) {
	for _, goos := range []string{"windows", "darwin"} {
		msg := caTakeoverHint(goos, caInstalledMachine)
		if strings.Contains(msg, "CA_FAILED") || strings.Contains(msg, "CA_DEGRADED") {
			t.Errorf("%s 本机域成功不应带告警前缀,got: %s", goos, msg)
		}
		if !strings.Contains(msg, "已接管") {
			t.Errorf("%s 本机域成功应是接管成功提示,got: %s", goos, msg)
		}
	}
}

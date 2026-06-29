package main

// 客户端画像漂移自检。不进常规测试,仅在 VERIFY_FP=1 时运行(与指纹漂移自检同一开关)。
//
// 跑法(Claude Code 升级后跑一下):
//
//	VERIFY_FP=1 go test -run TestClaudeClientProfileDrift -count=1 -v ./
//
// 原理:claudeCurrentUA 里钉着「当前真实发行版」的 cli 版本号(出口会把所有母号的 UA 归一到它)。
// Anthropic 滚版本后这个值会过时,导致全池上报一个偏旧的 cli 版本。这里 exec 本机真 `claude
// --version` 拿到真实在用的版本,与 claudeCurrentUA 内嵌版本比对:
//   - 一致 → PASS;
//   - 不一致 → FAIL,提示照真版本刷新 claudeCurrentUA / PkgVersion / NodeVersion 三件套
//     (PkgVersion、NodeVersion 需从真客户端抓包补,binary 里拿不到)。

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

var claudeVersionRe = regexp.MustCompile(`\d+\.\d+\.\d+`)

func TestClaudeClientProfileDrift(t *testing.T) {
	if os.Getenv("VERIFY_FP") != "1" {
		t.Skip("设 VERIFY_FP=1 才跑画像漂移自检(在装了 Claude Code 的机器上)")
	}
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("PATH 里没有 claude,跳过")
	}
	out, err := exec.Command(claudePath, "--version").Output()
	if err != nil {
		t.Skipf("`claude --version` 执行失败: %v", err)
	}
	realVer := claudeVersionRe.FindString(string(out))
	if realVer == "" {
		t.Skipf("无法从 %q 解析版本号", strings.TrimSpace(string(out)))
	}

	pinnedVer := claudeVersionRe.FindString(claudeCurrentUA)
	if pinnedVer == "" {
		t.Fatalf("claudeCurrentUA 里没有版本号: %q", claudeCurrentUA)
	}

	if pinnedVer != realVer {
		t.Fatalf("客户端画像已漂移:\n  钉住 cli 版本 = %s (claudeCurrentUA)\n  本机真实版本 = %s\n"+
			"→ 请按真客户端抓包刷新 claudeCurrentUA / claudeCurrentPkgVersion / claudeCurrentNodeVersion",
			pinnedVer, realVer)
	}
}

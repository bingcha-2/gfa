package main

import (
	"net/http"
	"strings"
)

// 出口客户端身份归一。真客户端的传输层指纹(UA / X-Stainless-* / X-App)原样透传时,同一母号
// 被多个租客使用就会暴露成"多台机器共用一个号"——device_id 在 body 层已按母号归一,传输层却没有,
// 二者矛盾。这里把传输层身份也收敛成「一台稳定机器」,分三类处理:
//
//	1) 同机不可变事实(Os / Arch)—— 按母号确定性锁定。一台机不会一会 Windows 一会 Mac、x64
//	   一会 arm64,这才是多租客共号的矛盾铁证。母号之间从真实组合表里分散选取,避免全池同构。
//	2) 版本耦合字段(UA / SDK Package-Version / node Runtime-Version)—— 归一到「当前真实发行版」。
//	   版本随更新前进是正常的,但同一母号同一时刻出现两个不同 cli 版本 = 不可能 → 必须统一;且统一
//	   到当前版而非按母号锁死某个旧版(锁旧 = 降级,本身可疑)。
//	3) 每请求 / 每会话动态字段(Anthropic-Beta / X-Stainless-Timeout / X-Stainless-Retry-Count /
//	   X-Client-Request-Id / X-Claude-Code-Session-Id)—— 透传不碰。实测同一 cli 版本 beta 集会随
//	   feature-gate 变、timeout 随 body 大小变,锁死反而扎眼。

// claudeCurrent* 是「当前真实发行版」的版本三件套,来自真 claude-desktop 抓包
// (claude-cli/2.1.187 · agent-sdk/0.3.187 · SDK 0.94.0 · 自带 node v24.3.0)。
// Anthropic 滚版本后由 fingerprint drift 自检提醒刷新(见 fingerprint_verify_test.go 同款机制)。
const (
	claudeCurrentUA          = "claude-cli/2.1.187 (external, claude-desktop, agent-sdk/0.3.187)"
	claudeCurrentPkgVersion  = "0.94.0"
	claudeCurrentNodeVersion = "v24.3.0"
)

// claudeOSArchProfiles 只含「同机不可变」的真实平台组合(无版本耦合 → 每条天然为真值,不需要
// 完整抓包即可入表)。按母号取模选取,给母号之间制造真实的环境分散。
var claudeOSArchProfiles = []struct{ OS, Arch string }{
	{"Windows", "x64"}, // 真抓包
	{"MacOS", "arm64"}, // 真抓包(Apple Silicon)
	{"MacOS", "x64"},   // Intel Mac
	{"Linux", "x64"},
}

// osArchForAccount 按母号确定性返回稳定的 (Os, Arch)。同一母号永远同一台机;
// accountID<=0(无号兜底)固定落第 0 条,避免负数取模。
func osArchForAccount(accountID int) (osName, arch string) {
	idx := 0
	if accountID > 0 {
		idx = accountID % len(claudeOSArchProfiles)
	}
	p := claudeOSArchProfiles[idx]
	return p.OS, p.Arch
}

// applyClaudeClientIdentity 在已透传客户端头的 dst 上覆盖出口身份字段(三类见文件头注释)。
func applyClaudeClientIdentity(dst, src http.Header, accountID int) {
	// ① 版本三件套:归一到当前真实发行版。
	dst.Set("User-Agent", claudeCurrentUA)
	dst.Set("X-Stainless-Package-Version", claudeCurrentPkgVersion)
	dst.Set("X-Stainless-Runtime-Version", claudeCurrentNodeVersion)
	dst.Set("X-Stainless-Runtime", "node")
	dst.Set("X-Stainless-Lang", "js")

	// ② 同机不可变事实:按母号锁定。
	osName, arch := osArchForAccount(accountID)
	dst.Set("X-Stainless-Os", osName)
	dst.Set("X-Stainless-Arch", arch)

	// X-App:正常归一为 cli;保留真客户端后台 haiku 任务发的 cli-bg 标记。
	if strings.EqualFold(strings.TrimSpace(src.Get("X-App")), "cli-bg") {
		dst.Set("X-App", "cli-bg")
	} else {
		dst.Set("X-App", "cli")
	}

	// ③ 动态字段(beta / timeout / retry-count / request-id / session-id)一律不碰 —— 透传。
}

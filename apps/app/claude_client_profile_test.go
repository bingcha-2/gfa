package main

import (
	"net/http"
	"testing"
)

// osArchForAccount 必须按母号确定性、稳定、且只返回表内真实组合。
func TestOSArchForAccount_DeterministicAndReal(t *testing.T) {
	valid := map[string]bool{}
	for _, p := range claudeOSArchProfiles {
		valid[p.OS+"/"+p.Arch] = true
	}

	for _, id := range []int{1, 2, 3, 4, 7, 99, 100000} {
		os1, arch1 := osArchForAccount(id)
		os2, arch2 := osArchForAccount(id)
		if os1 != os2 || arch1 != arch2 {
			t.Fatalf("accountID=%d 不稳定: (%s,%s) vs (%s,%s)", id, os1, arch1, os2, arch2)
		}
		if !valid[os1+"/"+arch1] {
			t.Fatalf("accountID=%d 返回了表外组合 (%s,%s)", id, os1, arch1)
		}
	}

	// accountID<=0(无号兜底)固定落第 0 条,不能 panic(负数取模)。
	if os0, arch0 := osArchForAccount(0); os0 != claudeOSArchProfiles[0].OS || arch0 != claudeOSArchProfiles[0].Arch {
		t.Fatalf("accountID=0 应落第 0 条, got (%s,%s)", os0, arch0)
	}
	osNeg, archNeg := osArchForAccount(-5)
	if osNeg != claudeOSArchProfiles[0].OS || archNeg != claudeOSArchProfiles[0].Arch {
		t.Fatalf("accountID<0 应落第 0 条, got (%s,%s)", osNeg, archNeg)
	}
}

// 版本三件套(UA / Package-Version / node Runtime-Version)无论客户端发什么,都归一到当前真实发行版。
func TestApplyClaudeUpstreamHeaders_NormalizesVersionTriple(t *testing.T) {
	src := http.Header{}
	src.Set("User-Agent", "claude-cli/2.1.181 (external, claude-desktop, agent-sdk/0.3.181)") // 旧版
	src.Set("X-Stainless-Package-Version", "0.90.0")
	src.Set("X-Stainless-Runtime-Version", "v20.0.0")
	src.Set("X-Stainless-Runtime", "deno")
	src.Set("X-Stainless-Lang", "ts")

	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", 7)

	if got := dst.Get("User-Agent"); got != claudeCurrentUA {
		t.Fatalf("UA 应归一到当前发行版\n want %s\n got  %s", claudeCurrentUA, got)
	}
	if got := dst.Get("X-Stainless-Package-Version"); got != claudeCurrentPkgVersion {
		t.Fatalf("Package-Version 应归一, want %s got %s", claudeCurrentPkgVersion, got)
	}
	if got := dst.Get("X-Stainless-Runtime-Version"); got != claudeCurrentNodeVersion {
		t.Fatalf("node Runtime-Version 应归一, want %s got %s", claudeCurrentNodeVersion, got)
	}
	if got := dst.Get("X-Stainless-Runtime"); got != "node" {
		t.Fatalf("Runtime 应为 node, got %s", got)
	}
	if got := dst.Get("X-Stainless-Lang"); got != "js" {
		t.Fatalf("Lang 应为 js, got %s", got)
	}
}

// Os/Arch 按母号锁定,且会覆盖客户端发来的真实值(消除"同号多机"矛盾)。
func TestApplyClaudeUpstreamHeaders_OSArchPinnedPerAccount(t *testing.T) {
	const acct = 1
	wantOS, wantArch := osArchForAccount(acct)

	src := http.Header{}
	// 客户端谎报另一套环境,必须被覆盖成母号锁定值。
	src.Set("X-Stainless-Os", "FreeBSD")
	src.Set("X-Stainless-Arch", "mips")

	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", acct)

	if got := dst.Get("X-Stainless-Os"); got != wantOS {
		t.Fatalf("Os 应锁定为 %s, got %s", wantOS, got)
	}
	if got := dst.Get("X-Stainless-Arch"); got != wantArch {
		t.Fatalf("Arch 应锁定为 %s, got %s", wantArch, got)
	}
}

// 每请求/每会话动态字段一律透传,绝不锁(锁了反而露馅)。
func TestApplyClaudeUpstreamHeaders_PassesThroughDynamicHeaders(t *testing.T) {
	src := http.Header{}
	src.Set("Anthropic-Beta", "claude-code-20250219,oauth-2025-04-20,advisor-tool-2026-03-01")
	src.Set("X-Stainless-Timeout", "900")
	src.Set("X-Stainless-Retry-Count", "0")
	src.Set("X-Client-Request-Id", "req-abc-123")
	src.Set("X-Claude-Code-Session-Id", "sess-xyz-789")

	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", 3)

	cases := map[string]string{
		"Anthropic-Beta":           "claude-code-20250219,oauth-2025-04-20,advisor-tool-2026-03-01",
		"X-Stainless-Timeout":      "900",
		"X-Stainless-Retry-Count":  "0",
		"X-Client-Request-Id":      "req-abc-123",
		"X-Claude-Code-Session-Id": "sess-xyz-789",
	}
	for k, want := range cases {
		if got := dst.Get(k); got != want {
			t.Fatalf("%s 应透传不变, want %q got %q", k, want, got)
		}
	}
}

// X-App:正常归一为 cli;但真客户端后台 haiku 任务发的 cli-bg 必须保留。
func TestApplyClaudeUpstreamHeaders_PreservesCliBg(t *testing.T) {
	// cli-bg 保留
	src := http.Header{}
	src.Set("X-App", "cli-bg")
	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", 2)
	if got := dst.Get("X-App"); got != "cli-bg" {
		t.Fatalf("cli-bg 应保留, got %q", got)
	}

	// 其它一律归一为 cli(含缺失 / 怪值)
	for _, in := range []string{"", "vscode", "cli"} {
		src := http.Header{}
		if in != "" {
			src.Set("X-App", in)
		}
		dst := http.Header{}
		applyClaudeUpstreamHeaders(dst, src, "oat", "https://api.anthropic.com/v1/messages", 2)
		if got := dst.Get("X-App"); got != "cli" {
			t.Fatalf("X-App=%q 应归一为 cli, got %q", in, got)
		}
	}
}

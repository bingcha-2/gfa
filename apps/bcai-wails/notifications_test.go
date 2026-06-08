package main

import "testing"

func TestClassifyError_Actionable(t *testing.T) {
	cases := []string{
		"此卡绑定的账号鉴权失效，请联系客服换号",
		"Claude token refresh failed: invalid_grant",
		"此卡绑定的账号不可用（不存在或已禁用），请联系客服",
		"出口代理未配置，请在 web 后台设置 proxyUrl",
		"HTTP 代理启动失败：端口被占用",
	}
	for _, msg := range cases {
		n := classifyError(msg)
		if n.Level != "block" {
			t.Errorf("classifyError(%q).Level = %q, want block", msg, n.Level)
		}
		if n.Recoverable {
			t.Errorf("classifyError(%q).Recoverable = true, want false (needs user action)", msg)
		}
	}
}

func TestClassifyError_Recoverable(t *testing.T) {
	cases := []string{
		"当前账号繁忙，额度恢复中，请稍后重试",
		"公平限额已用完，请等待额度恢复",
		"上游服务暂时不可用，请稍后重试",
		"账号容量不足，503",
	}
	for _, msg := range cases {
		n := classifyError(msg)
		if n.Level != "transient" {
			t.Errorf("classifyError(%q).Level = %q, want transient", msg, n.Level)
		}
		if !n.Recoverable {
			t.Errorf("classifyError(%q).Recoverable = false, want true (self-heals)", msg)
		}
	}
}

func TestClassifyError_UnknownIsTransient(t *testing.T) {
	// Unknown errors default to recoverable so we don't nag users with a blocking
	// banner for a one-off blip.
	n := classifyError("some unexpected weirdness")
	if n.Level != "transient" || !n.Recoverable {
		t.Errorf("unknown error classified as %+v, want transient/recoverable", n)
	}
}

func TestBuildNotifications_SkipsEmptyAndDedups(t *testing.T) {
	sources := []errorSource{
		{Source: "claude", Msg: "Claude token refresh failed: invalid_grant"},
		{Source: "codex", Msg: ""},                       // no error → skipped
		{Source: "antigravity", Msg: "额度恢复中，请稍后重试"}, // transient
		{Source: "claude2", Msg: "Claude token refresh failed: invalid_grant"}, // dup → deduped
	}
	out := buildNotifications(sources)
	if len(out) != 2 {
		t.Fatalf("buildNotifications produced %d, want 2 (empty skipped, dup deduped): %+v", len(out), out)
	}
	if out[0].Source != "claude" || out[0].Level != "block" {
		t.Errorf("first notification = %+v, want claude/block", out[0])
	}
	if out[1].Level != "transient" {
		t.Errorf("second notification = %+v, want transient", out[1])
	}
}

func TestBuildNotifications_AllEmpty(t *testing.T) {
	out := buildNotifications([]errorSource{{Source: "a", Msg: ""}, {Source: "b", Msg: "  "}})
	if len(out) != 0 {
		t.Errorf("buildNotifications(all empty) = %+v, want empty", out)
	}
}

func TestDerivedNotifications(t *testing.T) {
	// configured card but proxy not running → blocking startup error
	out := derivedNotifications(clientHealth{CardConfigured: true, ProxyRunning: false, PendingReports: 0})
	if len(out) != 1 || out[0].Level != "block" || out[0].Recoverable {
		t.Fatalf("proxy-down → %+v, want one block/non-recoverable", out)
	}

	// proxy running, but reports backed up → transient info
	out = derivedNotifications(clientHealth{CardConfigured: true, ProxyRunning: true, PendingReports: 3})
	if len(out) != 1 || out[0].Level != "transient" || !out[0].Recoverable {
		t.Fatalf("pending-reports → %+v, want one transient/recoverable", out)
	}

	// healthy → nothing
	if out := derivedNotifications(clientHealth{CardConfigured: true, ProxyRunning: true, PendingReports: 0}); len(out) != 0 {
		t.Fatalf("healthy → %+v, want none", out)
	}

	// not configured yet → no proxy-down nag
	if out := derivedNotifications(clientHealth{CardConfigured: false, ProxyRunning: false}); len(out) != 0 {
		t.Fatalf("unconfigured → %+v, want none", out)
	}
}

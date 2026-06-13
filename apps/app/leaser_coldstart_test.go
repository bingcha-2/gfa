package main

import (
	"net/http"
	"testing"
)

// 冷启动假报警的根因修复:首次自动租号前先用心跳 seed 订阅授权,StartAutoLease 才不会
// 盲探 antigravity。这里验证 seed 把「产品并集 + 是否有生效订阅」正确写进 leaser。
func TestSeedEntitlementsBeforeLease_SeedsActiveSub(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()
	seedLoggedInConfig(t, "tok-seed")

	resp := map[string]interface{}{
		"ok": true,
		"subscriptions": []interface{}{
			map[string]interface{}{"products": []interface{}{"codex", "anthropic"}},
		},
	}
	srv := newHeartbeatServer(t, resp, http.StatusOK)
	defer srv.Close()
	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()
	defer GetLeaser().ResetEntitlements()

	seedEntitlementsBeforeLease(LoadConfig())

	l := GetLeaser()
	l.mu.RLock()
	known, sub := l.entitlementsKnown, l.subActive
	prods := append([]string(nil), l.entitledProducts...)
	l.mu.RUnlock()

	if !known || !sub {
		t.Fatalf("seed 后应 entitlementsKnown=subActive=true,得 known=%v sub=%v", known, sub)
	}
	if !sameStringSet(prods, []string{"anthropic", "codex"}) {
		t.Fatalf("seed 后 entitledProducts 应为并集去重,得 %v", prods)
	}
}

// 服务端对「无生效订阅」返回 200 + subscriptions:[](非 403)。seed 必须把它判成
// 「确知无生效订阅」,这样随后的 StartAutoLease 走 entitlementsKnownNoSub 直接判死,
// 不再盲探一次 antigravity 才发现。
func TestSeedEntitlementsBeforeLease_NoSubSeedsKnownNoSub(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()
	seedLoggedInConfig(t, "tok-nosub")

	srv := newHeartbeatServer(t, map[string]interface{}{"ok": true, "subscriptions": []interface{}{}}, http.StatusOK)
	defer srv.Close()
	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()
	defer GetLeaser().ResetEntitlements()

	seedEntitlementsBeforeLease(LoadConfig())

	if !GetLeaser().entitlementsKnownNoSub() {
		t.Fatal("空 subscriptions 应被 seed 成「确知无生效订阅」")
	}
}

// 网络/旧服务端失败 → 不 seed(授权保持未知),回退老的盲探逻辑,行为不退化。
func TestSeedEntitlementsBeforeLease_HTTPErrorDoesNotSeed(t *testing.T) {
	tmpDir := t.TempDir()
	origConfigDir = tmpDir
	defer func() { origConfigDir = "" }()
	seedLoggedInConfig(t, "tok-err")

	srv := newHeartbeatServer(t, map[string]string{"error": "boom"}, http.StatusInternalServerError)
	defer srv.Close()
	origAuthBase := authBaseURL
	authBaseURL = srv.URL
	defer func() { authBaseURL = origAuthBase }()
	defer GetLeaser().ResetEntitlements()

	GetLeaser().ResetEntitlements() // 起点:授权未知
	seedEntitlementsBeforeLease(LoadConfig())

	l := GetLeaser()
	l.mu.RLock()
	known := l.entitlementsKnown
	l.mu.RUnlock()
	if known {
		t.Fatal("心跳非 200 不应 seed 授权(须回退盲探逻辑)")
	}
}

// serviceState 不能把「卡不可用 / 有效订阅但未开 antigravity」这些 cachedToken 恒空的稳态
// 误报成永久「获取租约中…」(waiting_first_lease)。这是 StatusPill 卡在「获取租约中」的根因。
func TestServiceState_NotStuckWaiting(t *testing.T) {
	t.Run("有效订阅·只开codex → ready(不再卡获取租约中)", func(t *testing.T) {
		l := &Leaser{}
		l.SetEntitlements([]string{"codex"}, true)
		if got := l.GetStatus()["serviceState"]; got != "ready" {
			t.Fatalf("codex-only 有效订阅应 ready,得 %v", got)
		}
	})

	t.Run("卡密不可用 → 不是 waiting_first_lease", func(t *testing.T) {
		l := &Leaser{cardUnusable: true}
		if got := l.GetStatus()["serviceState"]; got == "waiting_first_lease" {
			t.Fatalf("cardUnusable 不应报 waiting_first_lease,得 %v", got)
		}
	})

	t.Run("冷启动尚未知授权·无 token → 仍是 waiting_first_lease", func(t *testing.T) {
		l := &Leaser{}
		if got := l.GetStatus()["serviceState"]; got != "waiting_first_lease" {
			t.Fatalf("冷启动确在等首租,应 waiting_first_lease,得 %v", got)
		}
	})
}

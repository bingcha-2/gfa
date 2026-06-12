package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTargetRequiredProduct(t *testing.T) {
	cases := map[string]string{
		"codex":           "codex",
		"antigravity_ide": "antigravity",
		"antigravity_hub": "antigravity",
		"claude_code":     "anthropic",
		"unknown":         "",
	}
	for in, want := range cases {
		if got := targetRequiredProduct(in); got != want {
			t.Fatalf("targetRequiredProduct(%q)=%q want %q", in, got, want)
		}
	}
}

func TestRefreshCardProductsForTakeoverUsesLatestActivationStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"success": true,
			"data": {
				"accountCard": {"expiresAt": "2027-01-01T00:00:00Z"},
				"accessKeyStatus": {"products": ["anthropic", "codex"]}
			}
		}`))
	}))
	defer srv.Close()
	oldBase := API_BASE
	API_BASE = srv.URL
	t.Cleanup(func() { API_BASE = oldBase })

	GetLeaser().syncFromServer(map[string]interface{}{
		"products": []interface{}{"anthropic"},
	})

	products := refreshCardProductsForTakeover("card-1", "dev-1", "")
	if !cardCoversProduct(products, "codex") {
		t.Fatalf("expected refreshed products to cover codex, got %v", products)
	}
}

func TestClaudeCodeTargetIsRegistered(t *testing.T) {
	// Lookup by dispatch key and by product id both resolve the same target.
	byKey := findTakeoverTarget("claude")
	byProduct := findTakeoverTarget("claude_code")
	if byKey == nil || byProduct == nil {
		t.Fatal("claudeCodeTarget must be registered (lookup by key and product id)")
	}
	if byKey.ProductID() != "claude_code" || byProduct.Key() != "claude" {
		t.Fatalf("unexpected target identity: key=%q product=%q", byProduct.Key(), byKey.ProductID())
	}
	if byKey.InjectionType() != "settings" {
		t.Fatalf("claude target should inject via settings, got %q", byKey.InjectionType())
	}
}

func TestProductLabelAnthropic(t *testing.T) {
	if productLabel("anthropic") != "Anthropic" {
		t.Fatalf("productLabel(anthropic)=%q want Anthropic", productLabel("anthropic"))
	}
}

func TestAnthropicCardGating(t *testing.T) {
	// An anthropic-only card may take over Claude Code but not codex/antigravity.
	if !cardCoversProduct([]string{"anthropic"}, "anthropic") {
		t.Fatal("anthropic card should cover anthropic")
	}
	if cardCoversProduct([]string{"anthropic"}, "codex") {
		t.Fatal("anthropic-only card must NOT cover codex")
	}
	if cardCoversProduct([]string{"codex"}, "anthropic") {
		t.Fatal("codex-only card must NOT cover anthropic")
	}
	// 过渡兼容:连到未升级服务端(products=["claude"])时,anthropic 门控仍放行。
	if !cardCoversProduct([]string{"claude"}, "anthropic") {
		t.Fatal("legacy claude product must still satisfy the anthropic gate")
	}
}

func TestCardCoversProduct(t *testing.T) {
	// 池子卡(products 为空)→ 覆盖一切产品。
	if !cardCoversProduct(nil, "antigravity") || !cardCoversProduct([]string{}, "codex") {
		t.Fatal("池子卡应覆盖任意产品")
	}
	// 绑定卡:只覆盖自己绑的产品。
	if !cardCoversProduct([]string{"codex"}, "codex") {
		t.Fatal("codex 卡应覆盖 codex")
	}
	if cardCoversProduct([]string{"codex"}, "antigravity") {
		t.Fatal("codex 卡不应覆盖 antigravity(应拒绝接管)")
	}
	if !cardCoversProduct([]string{"codex", "antigravity"}, "antigravity") {
		t.Fatal("通用卡应覆盖 antigravity")
	}
	// required 为空(未知目标)→ 不限制。
	if !cardCoversProduct([]string{"codex"}, "") {
		t.Fatal("空 required 应放行")
	}
}

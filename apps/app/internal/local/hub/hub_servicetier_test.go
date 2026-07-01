package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
)

// Wave L:hub 层按号服务档 —— 仅 codex 自有号可设,持久化并透出到 view。

func TestHub_SetCodexAccountServiceTier(t *testing.T) {
	h, _ := newHub(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "svc@x.com", PoolEnabled: true}
	_ = h.acc.Add(a)

	if err := h.SetCodexAccountServiceTier(a.ID, "fast"); err != nil {
		t.Fatalf("SetCodexAccountServiceTier: %v", err)
	}
	got, _ := h.acc.Get(a.ID)
	if got.ServiceTier != "fast" {
		t.Fatalf("service_tier not persisted: %q", got.ServiceTier)
	}

	// 透出到 view。
	views, _ := h.ListAccounts(account.ProviderCodex)
	if len(views) != 1 || views[0].ServiceTier != "fast" {
		t.Fatalf("view should surface fast tier: %+v", views)
	}

	// 清回继承。
	if err := h.SetCodexAccountServiceTier(a.ID, "standard"); err != nil {
		t.Fatalf("clear tier: %v", err)
	}
	if got, _ := h.acc.Get(a.ID); got.ServiceTier != "" {
		t.Fatalf("tier not cleared: %q", got.ServiceTier)
	}
}

// 红线:该能力仅 codex —— 对非 codex(antigravity)号应拒绝,不落库。
func TestHub_SetServiceTier_RejectsNonCodex(t *testing.T) {
	h, _ := newHub(t)
	a := &account.Account{Provider: account.ProviderAntigravity, Email: "ag@x.com", PoolEnabled: true}
	_ = h.acc.Add(a)
	if err := h.SetCodexAccountServiceTier(a.ID, "fast"); err == nil {
		t.Fatal("expected error setting service tier on a non-codex account")
	}
	if got, _ := h.acc.Get(a.ID); got.ServiceTier != "" {
		t.Fatalf("non-codex account tier must stay empty, got %q", got.ServiceTier)
	}
}

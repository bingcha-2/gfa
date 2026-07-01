package manager

import (
	"testing"

	"bcai-wails/internal/local/account"
)

// Wave L:按号服务档在 manager 层落库、归一、并透出到 AccountView。

func TestSetServiceTier_PersistsAndReloads(t *testing.T) {
	m, acc, fr := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "svc@x", PoolEnabled: true}
	_ = acc.Add(a)

	if err := m.SetServiceTier(a.ID, "fast"); err != nil {
		t.Fatalf("SetServiceTier: %v", err)
	}
	got, _ := acc.Get(a.ID)
	if got.ServiceTier != "fast" {
		t.Fatalf("service_tier not persisted: %q", got.ServiceTier)
	}
	if fr.n == 0 {
		t.Fatal("expected gateway reload after service tier change")
	}

	// 归一:任意「快速同义词」都落成 "fast"。
	if err := m.SetServiceTier(a.ID, "priority"); err != nil {
		t.Fatalf("SetServiceTier priority: %v", err)
	}
	if got, _ := acc.Get(a.ID); got.ServiceTier != "fast" {
		t.Fatalf("priority should normalize to fast, got %q", got.ServiceTier)
	}

	// 空/standard 清回继承。
	if err := m.SetServiceTier(a.ID, "standard"); err != nil {
		t.Fatalf("SetServiceTier standard: %v", err)
	}
	if got, _ := acc.Get(a.ID); got.ServiceTier != "" {
		t.Fatalf("standard should clear to empty, got %q", got.ServiceTier)
	}
}

func TestAccountView_ServiceTierSurfaced(t *testing.T) {
	m, acc, _ := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "v@x", PoolEnabled: true, ServiceTier: "fast"}
	_ = acc.Add(a)
	views, err := m.ListAccounts()
	if err != nil || len(views) != 1 {
		t.Fatalf("list: %v len=%d", err, len(views))
	}
	if views[0].ServiceTier != "fast" {
		t.Fatalf("view should surface service tier, got %q", views[0].ServiceTier)
	}
}

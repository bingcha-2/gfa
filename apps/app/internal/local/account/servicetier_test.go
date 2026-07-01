package account

import "testing"

// Wave L:按号服务档(ServiceTier)在 store 持久化并可 round-trip。
// 空值=继承/standard;"fast"=priority(对齐 cockpit accounts.updateAppSpeed)。

func TestStore_ServiceTierPersistsOnAdd(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "svc@y.com", PoolEnabled: true, ServiceTier: "fast"}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, _ := s.Get(a.ID)
	if got.ServiceTier != "fast" {
		t.Fatalf("service_tier not persisted on add: %q", got.ServiceTier)
	}
}

func TestStore_ServiceTierUpdateRoundTrip(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "svc2@y.com", PoolEnabled: true}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	// 默认应为空(继承)。
	got, _ := s.Get(a.ID)
	if got.ServiceTier != "" {
		t.Fatalf("default service_tier should be empty, got %q", got.ServiceTier)
	}
	// 设 fast → 落库。
	got.ServiceTier = "fast"
	if err := s.Update(got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if again, _ := s.Get(a.ID); again.ServiceTier != "fast" {
		t.Fatalf("service_tier not updated to fast: %q", again.ServiceTier)
	}
	// 归零 → 空(回到继承)。
	got.ServiceTier = ""
	if err := s.Update(got); err != nil {
		t.Fatalf("Update back to standard: %v", err)
	}
	if again, _ := s.Get(a.ID); again.ServiceTier != "" {
		t.Fatalf("service_tier not cleared: %q", again.ServiceTier)
	}
}

func TestNormalizeServiceTier(t *testing.T) {
	// 对齐 cockpit codex_speed.normalize_service_tier_speed:{fast,priority,flex}→fast,其余→""(standard/继承)。
	cases := map[string]string{
		"fast":     "fast",
		"priority": "fast",
		"flex":     "fast",
		"FAST":     "fast",
		"":         "",
		"standard": "",
		"default":  "",
		"garbage":  "",
	}
	for in, want := range cases {
		if got := NormalizeServiceTier(in); got != want {
			t.Fatalf("NormalizeServiceTier(%q)=%q want %q", in, got, want)
		}
	}
}

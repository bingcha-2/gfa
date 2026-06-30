package account

import (
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := OpenStore(filepath.Join(dir, "accounts.db"))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestStore_AddListGetDelete(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "x@y.com", AuthKind: AuthOAuth, RefreshToken: "rt", PoolEnabled: true}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if a.ID == "" {
		t.Fatal("expected generated ID")
	}
	got, err := s.Get(a.ID)
	if err != nil || got.Email != "x@y.com" {
		t.Fatalf("Get mismatch: %+v %v", got, err)
	}
	list, _ := s.List(ProviderCodex)
	if len(list) != 1 {
		t.Fatalf("List len=%d", len(list))
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	list, _ = s.List(ProviderCodex)
	if len(list) != 0 {
		t.Fatalf("after delete len=%d", len(list))
	}
}

func TestStore_PoolEnabledFilter(t *testing.T) {
	s := newTestStore(t)
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "in@y.com", PoolEnabled: true, RefreshToken: "a"})
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "out@y.com", PoolEnabled: false, RefreshToken: "b"})
	pool, _ := s.ListPoolEnabled(ProviderCodex)
	if len(pool) != 1 || pool[0].Email != "in@y.com" {
		t.Fatalf("pool filter wrong: %+v", pool)
	}
}

func TestStore_UpdateRoundTrip(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "u@y.com", PoolEnabled: true, RefreshToken: "rt", Tags: []string{"主力"}}
	_ = s.Add(a)
	a.PlanType = "pro"
	a.HourlyPercent = 42
	a.Priority = true
	a.QuotaStatus = QuotaOK
	a.ProjectID = "gcp-proj-1"
	a.Name = "我的主号"
	if err := s.Update(a); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got, _ := s.Get(a.ID)
	if got.PlanType != "pro" || got.HourlyPercent != 42 || !got.Priority || got.QuotaStatus != QuotaOK || len(got.Tags) != 1 || got.Tags[0] != "主力" || got.ProjectID != "gcp-proj-1" || got.Name != "我的主号" {
		t.Fatalf("update round-trip wrong: %+v", got)
	}
}

func TestStore_NamePersistsOnAdd(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "n@y.com", Name: "显示名", PoolEnabled: true}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, _ := s.Get(a.ID)
	if got.Name != "显示名" {
		t.Fatalf("name not persisted: %+v", got)
	}
}

// 网关只喂 codex:ListPoolEnabled(codex) 不应混入 antigravity 进池号。
func TestStore_ListPoolEnabled_ProviderScoped(t *testing.T) {
	s := newTestStore(t)
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "c@y.com", PoolEnabled: true})
	_ = s.Add(&Account{Provider: ProviderAntigravity, Email: "a@y.com", PoolEnabled: true})
	_ = s.Add(&Account{Provider: ProviderCodex, Email: "off@y.com", PoolEnabled: false})
	codex, err := s.ListPoolEnabled(ProviderCodex)
	if err != nil {
		t.Fatalf("ListPoolEnabled: %v", err)
	}
	if len(codex) != 1 || codex[0].Email != "c@y.com" {
		t.Fatalf("expected only the codex pool account, got %+v", codex)
	}
}

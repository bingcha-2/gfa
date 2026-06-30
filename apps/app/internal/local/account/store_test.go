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

func TestStore_ExpiryAndGCPTosPersist(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderAntigravity, Email: "ent@corp.com", PoolEnabled: true, Expiry: 1893456000, IsGCPTos: true}
	if err := s.Add(a); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, _ := s.Get(a.ID)
	if got.Expiry != 1893456000 || !got.IsGCPTos {
		t.Fatalf("expiry/is_gcp_tos not persisted on add: %+v", got)
	}
	got.Expiry = 1900000000
	got.IsGCPTos = false
	if err := s.Update(got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	again, _ := s.Get(a.ID)
	if again.Expiry != 1900000000 || again.IsGCPTos {
		t.Fatalf("expiry/is_gcp_tos not updated: %+v", again)
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

// Reorder 按给定 id 顺序持久化排序;List 优先按 sort_order 升序,其次 created_at。
func TestStore_ReorderOrdersList(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "a@y.com", PoolEnabled: true}
	b := &Account{Provider: ProviderCodex, Email: "b@y.com", PoolEnabled: true}
	c := &Account{Provider: ProviderCodex, Email: "c@y.com", PoolEnabled: true}
	_ = s.Add(a)
	_ = s.Add(b)
	_ = s.Add(c)
	// 默认按 created_at:a,b,c
	if list, _ := s.List(ProviderCodex); list[0].Email != "a@y.com" || list[2].Email != "c@y.com" {
		t.Fatalf("default order wrong: %+v", list)
	}
	if err := s.Reorder(ProviderCodex, []string{c.ID, a.ID, b.ID}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	list, _ := s.List(ProviderCodex)
	if list[0].Email != "c@y.com" || list[1].Email != "a@y.com" || list[2].Email != "b@y.com" {
		t.Fatalf("reordered list wrong: %+v", list)
	}
}

// Reorder 只影响指定 provider;未列出的号排到尾部(保持稳定)。
func TestStore_ReorderProviderScopedAndStable(t *testing.T) {
	s := newTestStore(t)
	a := &Account{Provider: ProviderCodex, Email: "a@y.com", PoolEnabled: true}
	b := &Account{Provider: ProviderCodex, Email: "b@y.com", PoolEnabled: true}
	ag := &Account{Provider: ProviderAntigravity, Email: "ag@y.com", PoolEnabled: true}
	_ = s.Add(a)
	_ = s.Add(b)
	_ = s.Add(ag)
	// 只给 b 一个 id,a 未列出应排到 b 之后。
	if err := s.Reorder(ProviderCodex, []string{b.ID}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	codex, _ := s.List(ProviderCodex)
	if len(codex) != 2 || codex[0].Email != "b@y.com" || codex[1].Email != "a@y.com" {
		t.Fatalf("scoped/stable order wrong: %+v", codex)
	}
	// antigravity 不受影响。
	agList, _ := s.List(ProviderAntigravity)
	if len(agList) != 1 || agList[0].Email != "ag@y.com" {
		t.Fatalf("antigravity should be untouched: %+v", agList)
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

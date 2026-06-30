package accountgroups

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(t.TempDir())
}

func TestLoadEmptyWhenMissing(t *testing.T) {
	dir := t.TempDir()
	got, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Load() = %+v, want empty", got)
	}
	// 缺省时不应写盘
	if _, err := os.Stat(filepath.Join(dir, fileName)); !os.IsNotExist(err) {
		t.Fatalf("Load() must not create file when missing, stat err = %v", err)
	}
}

func TestLoadCorruptFallsBackToEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("corrupt Load() = %+v, want empty", got)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	in := []Group{
		{ID: "g1", Name: "alpha", SortOrder: 1, AccountIDs: []string{"a", "b"}, CreatedAt: 100},
		{ID: "g2", Name: "beta", SortOrder: 2, AccountIDs: nil, CreatedAt: 200},
	}
	if err := s.Save(in); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	got, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got) != 2 || got[0].ID != "g1" || got[0].Name != "alpha" || len(got[0].AccountIDs) != 2 {
		t.Fatalf("round-trip = %+v", got)
	}
}

func TestSaveIsAtomicNoTempLeftover(t *testing.T) {
	dir := t.TempDir()
	if err := NewStore(dir).Save([]Group{{ID: "g1", Name: "x"}}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("Save() left temp file %q", e.Name())
		}
	}
}

func TestSaveSerializesAsJSONArray(t *testing.T) {
	dir := t.TempDir()
	if err := NewStore(dir).Save([]Group{{ID: "g1", Name: "x"}}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	var arr []map[string]any
	if err := json.Unmarshal(data, &arr); err != nil {
		t.Fatalf("on-disk content not a JSON array: %v\n%s", err, data)
	}
	if _, ok := arr[0]["accountIds"]; !ok {
		t.Fatalf("expected camelCase accountIds key, got %v", arr[0])
	}
}

func TestCreateAssignsIDAndSortOrder(t *testing.T) {
	s := newStore(t)
	g1, err := s.Create("first")
	if err != nil {
		t.Fatal(err)
	}
	if g1.ID == "" {
		t.Fatal("Create() empty id")
	}
	if g1.Name != "first" {
		t.Fatalf("name = %q", g1.Name)
	}
	g2, err := s.Create("  second  ")
	if err != nil {
		t.Fatal(err)
	}
	if g2.Name != "second" {
		t.Fatalf("name not trimmed: %q", g2.Name)
	}
	if g2.SortOrder <= g1.SortOrder {
		t.Fatalf("sortOrder not increasing: %d <= %d", g2.SortOrder, g1.SortOrder)
	}
	if g1.ID == g2.ID {
		t.Fatalf("ids collide: %s", g1.ID)
	}
}

func TestListReturnsSortedBySortOrder(t *testing.T) {
	s := newStore(t)
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	// 把 a 排到 b 后面
	if _, err := s.UpdateSortOrder(a.ID, 99); err != nil {
		t.Fatal(err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != b.ID || got[1].ID != a.ID {
		t.Fatalf("List() order = %+v", got)
	}
}

func TestRenameTrimsAndPersists(t *testing.T) {
	s := newStore(t)
	g, _ := s.Create("old")
	out, err := s.Rename(g.ID, "  new  ")
	if err != nil {
		t.Fatal(err)
	}
	if out == nil || out.Name != "new" {
		t.Fatalf("Rename() = %+v", out)
	}
	missing, err := s.Rename("nope", "x")
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Fatalf("Rename(missing) = %+v, want nil", missing)
	}
}

func TestDeleteRemovesGroup(t *testing.T) {
	s := newStore(t)
	g, _ := s.Create("g")
	if err := s.Delete(g.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.List()
	if len(got) != 0 {
		t.Fatalf("after delete = %+v", got)
	}
}

func TestAssignMovesAccountsAndIsExclusive(t *testing.T) {
	s := newStore(t)
	g1, _ := s.Create("g1")
	g2, _ := s.Create("g2")
	if _, err := s.Assign(g1.ID, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	// 再把 a 分到 g2,应从 g1 移除(独占)
	out, err := s.Assign(g2.ID, []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	if out == nil || len(out.AccountIDs) != 1 || out.AccountIDs[0] != "a" {
		t.Fatalf("g2 = %+v", out)
	}
	groups, _ := s.List()
	for _, g := range groups {
		if g.ID == g1.ID {
			if len(g.AccountIDs) != 1 || g.AccountIDs[0] != "b" {
				t.Fatalf("g1 should keep only b, got %+v", g.AccountIDs)
			}
		}
	}
}

func TestAssignNoDuplicates(t *testing.T) {
	s := newStore(t)
	g, _ := s.Create("g")
	if _, err := s.Assign(g.ID, []string{"a", "a", "b"}); err != nil {
		t.Fatal(err)
	}
	out, _ := s.Assign(g.ID, []string{"a"})
	if len(out.AccountIDs) != 2 {
		t.Fatalf("duplicates not deduped: %+v", out.AccountIDs)
	}
}

func TestRemoveAccounts(t *testing.T) {
	s := newStore(t)
	g, _ := s.Create("g")
	s.Assign(g.ID, []string{"a", "b", "c"})
	out, err := s.RemoveAccounts(g.ID, []string{"b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.AccountIDs) != 2 || out.AccountIDs[0] != "a" || out.AccountIDs[1] != "c" {
		t.Fatalf("RemoveAccounts = %+v", out.AccountIDs)
	}
}

func TestCleanupDeletedAccounts(t *testing.T) {
	s := newStore(t)
	g, _ := s.Create("g")
	s.Assign(g.ID, []string{"a", "b", "c"})
	if err := s.CleanupDeletedAccounts(map[string]bool{"a": true, "c": true}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.List()
	if len(got[0].AccountIDs) != 2 {
		t.Fatalf("cleanup left = %+v", got[0].AccountIDs)
	}
}

func TestGroupOfAccount(t *testing.T) {
	s := newStore(t)
	g1, _ := s.Create("g1")
	s.Create("g2")
	s.Assign(g1.ID, []string{"a"})

	groups, _ := s.List()
	if gid := GroupOfAccount(groups, "a"); gid != g1.ID {
		t.Fatalf("GroupOfAccount(a) = %q, want %q", gid, g1.ID)
	}
	if gid := GroupOfAccount(groups, "zzz"); gid != "" {
		t.Fatalf("GroupOfAccount(unknown) = %q, want empty", gid)
	}
}

func TestResolveAccountGroups(t *testing.T) {
	s := newStore(t)
	g1, _ := s.Create("g1")
	g2, _ := s.Create("g2")
	s.Assign(g1.ID, []string{"a", "b"})
	s.Assign(g2.ID, []string{"c"})

	groups, _ := s.List()
	m := ResolveAccountGroups(groups)
	if m["a"] != g1.ID || m["b"] != g1.ID || m["c"] != g2.ID {
		t.Fatalf("ResolveAccountGroups = %+v", m)
	}
	if _, ok := m["zzz"]; ok {
		t.Fatalf("unexpected key present")
	}
}

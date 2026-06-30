package gatewaykeys

import (
	"strings"
	"testing"
)

func TestStore_CreateAssignsIDValueAndTime(t *testing.T) {
	s := NewStore(t.TempDir())
	k, err := s.Create("laptop")
	if err != nil {
		t.Fatal(err)
	}
	if k.ID == "" {
		t.Fatal("expected non-empty id")
	}
	if k.Name != "laptop" {
		t.Fatalf("name = %q, want laptop", k.Name)
	}
	if !strings.HasPrefix(k.Value, "sk-") {
		t.Fatalf("value = %q, want sk- prefix", k.Value)
	}
	if k.CreatedAt == 0 {
		t.Fatal("expected createdAt set")
	}
}

func TestStore_ListPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	a, _ := s.Create("a")
	b, _ := s.Create("b")

	got := NewStore(dir).List()
	if len(got) != 2 {
		t.Fatalf("list len = %d, want 2", len(got))
	}
	// 按创建顺序返回。
	if got[0].ID != a.ID || got[1].ID != b.ID {
		t.Fatalf("order mismatch: %v", got)
	}
}

func TestStore_DeleteRemoves(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	got := s.List()
	if len(got) != 1 || got[0].ID != b.ID {
		t.Fatalf("after delete list = %v, want only %s", got, b.ID)
	}
}

func TestStore_DeleteUnknownIsNoError(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Delete("nope"); err != nil {
		t.Fatalf("delete unknown should be no-op, got %v", err)
	}
}

func TestStore_RotateKeepsIDNameChangesValue(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	a, _ := s.Create("a")
	oldVal := a.Value
	rotated, err := s.Rotate(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.ID != a.ID || rotated.Name != a.Name {
		t.Fatalf("rotate changed id/name: %+v", rotated)
	}
	if rotated.Value == oldVal {
		t.Fatal("rotate should change value")
	}
	// 持久化:重开仍是新值。
	got := NewStore(dir).List()
	if len(got) != 1 || got[0].Value != rotated.Value {
		t.Fatalf("rotated value not persisted: %v", got)
	}
}

func TestStore_RotateUnknownErrors(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Rotate("nope"); err == nil {
		t.Fatal("expected error rotating unknown key")
	}
}

func TestStore_Values(t *testing.T) {
	s := NewStore(t.TempDir())
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	vals := s.Values()
	if len(vals) != 2 || vals[0] != a.Value || vals[1] != b.Value {
		t.Fatalf("Values = %v, want [%s %s]", vals, a.Value, b.Value)
	}
}

func TestStore_UniqueValues(t *testing.T) {
	s := NewStore(t.TempDir())
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	if a.Value == b.Value {
		t.Fatal("expected unique generated values")
	}
}

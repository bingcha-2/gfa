package modelprovider

import (
	"testing"
)

func TestSaveCreatesAndAssignsID(t *testing.T) {
	s := NewStore(t.TempDir())
	got, err := s.Save(Provider{Name: "deepseek", BaseURL: "https://api.deepseek.com/v1", APIKey: "k1"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got.ID == "" {
		t.Fatal("expected generated id")
	}
	if got.CreatedAt == 0 {
		t.Fatal("expected createdAt set")
	}
	// baseURL 含 deepseek → 启发式归一为 chat_completions。
	if got.WireAPI != WireChatCompletions {
		t.Fatalf("wireApi = %q, want chat_completions", got.WireAPI)
	}
	list := s.List()
	if len(list) != 1 || list[0].ID != got.ID {
		t.Fatalf("List = %+v", list)
	}
}

func TestSaveRejectsMissingFields(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Save(Provider{BaseURL: "https://x"}); err == nil {
		t.Fatal("expected error for missing name")
	}
	if _, err := s.Save(Provider{Name: "x"}); err == nil {
		t.Fatal("expected error for missing baseURL")
	}
}

func TestSaveUpdatesPreservesCreatedAt(t *testing.T) {
	s := NewStore(t.TempDir())
	a, _ := s.Save(Provider{Name: "a", BaseURL: "https://api.openai.com/v1", APIKey: "k"})
	a.Name = "renamed"
	a.APIKey = "k2"
	updated, err := s.Save(a)
	if err != nil {
		t.Fatalf("update Save: %v", err)
	}
	if updated.CreatedAt != a.CreatedAt {
		t.Fatalf("createdAt changed: %d -> %d", a.CreatedAt, updated.CreatedAt)
	}
	if list := s.List(); len(list) != 1 || list[0].Name != "renamed" || list[0].APIKey != "k2" {
		t.Fatalf("upsert produced wrong list: %+v", list)
	}
}

func TestDeleteIdempotent(t *testing.T) {
	s := NewStore(t.TempDir())
	a, _ := s.Save(Provider{Name: "a", BaseURL: "https://api.openai.com/v1", APIKey: "k"})
	if err := s.Delete(a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(s.List()) != 0 {
		t.Fatal("expected empty after delete")
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatalf("second Delete should be idempotent: %v", err)
	}
	if err := s.Delete(""); err == nil {
		t.Fatal("expected error for empty id")
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s1 := NewStore(dir)
	saved, _ := s1.Save(Provider{Name: "a", BaseURL: "https://api.openai.com/v1", APIKey: "k", ModelCatalog: []string{"gpt-5", "gpt-5", " gpt-4o "}})
	// dedup + trim on catalog.
	if len(saved.ModelCatalog) != 2 || saved.ModelCatalog[1] != "gpt-4o" {
		t.Fatalf("catalog not cleaned: %+v", saved.ModelCatalog)
	}
	s2 := NewStore(dir)
	got, ok := s2.Get(saved.ID)
	if !ok {
		t.Fatal("expected provider after reopen")
	}
	if got.Name != "a" || got.WireAPI != WireResponses {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestSetModelCatalog(t *testing.T) {
	s := NewStore(t.TempDir())
	a, _ := s.Save(Provider{Name: "a", BaseURL: "https://api.openai.com/v1", APIKey: "k"})
	if err := s.SetModelCatalog(a.ID, []string{"m1", "m2"}); err != nil {
		t.Fatalf("SetModelCatalog: %v", err)
	}
	got, _ := s.Get(a.ID)
	if len(got.ModelCatalog) != 2 {
		t.Fatalf("catalog = %+v", got.ModelCatalog)
	}
	if err := s.SetModelCatalog("nope", []string{"x"}); err == nil {
		t.Fatal("expected error for unknown id")
	}
}

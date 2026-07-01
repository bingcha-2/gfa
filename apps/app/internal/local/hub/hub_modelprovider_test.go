package hub

import (
	"testing"

	"bcai-wails/internal/local/modelprovider"
)

func modelProviderFixture() modelprovider.Provider {
	return modelprovider.Provider{
		Name:    "deepseek",
		BaseURL: "https://api.deepseek.com/v1",
		APIKey:  "k1",
	}
}

func TestHubModelProviderCRUD(t *testing.T) {
	h, _ := newHub(t)
	if got := h.ListModelProviders(); len(got) != 0 {
		t.Fatalf("expected empty, got %+v", got)
	}
	saved, err := h.SaveModelProvider(modelProviderFixture())
	if err != nil {
		t.Fatalf("SaveModelProvider: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected generated id")
	}
	if saved.WireAPI != modelprovider.WireChatCompletions {
		t.Fatalf("wireApi heuristic = %q, want chat_completions", saved.WireAPI)
	}
	if got := h.ListModelProviders(); len(got) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(got))
	}
	if err := h.DeleteModelProvider(saved.ID); err != nil {
		t.Fatalf("DeleteModelProvider: %v", err)
	}
	if got := h.ListModelProviders(); len(got) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(got))
	}
}

func TestHubTestModelProviderUnknownID(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.TestModelProvider("nope"); err == nil {
		t.Fatal("expected error for unknown provider id")
	}
	if _, err := h.ListModelProviderModels("nope"); err == nil {
		t.Fatal("expected error for unknown provider id")
	}
}

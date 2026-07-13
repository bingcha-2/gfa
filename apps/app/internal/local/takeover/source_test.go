package takeover

import "testing"

func TestNormalize(t *testing.T) {
	if Normalize("local") != SourceLocal {
		t.Fatal("local")
	}
	if Normalize("remote") != SourceRemote {
		t.Fatal("remote")
	}
	if Normalize("") != SourceRemote || Normalize("garbage") != SourceRemote {
		t.Fatal("default should be remote")
	}
}

func TestNormalizeProvider(t *testing.T) {
	if Normalize("provider") != SourceProvider {
		t.Fatal("bare provider")
	}
	if Normalize("provider:abc123") != SourceProvider {
		t.Fatal("composite provider:id should normalize to provider")
	}
}

func TestProviderID(t *testing.T) {
	if got := ProviderID("provider:abc123"); got != "abc123" {
		t.Fatalf("ProviderID = %q, want abc123", got)
	}
	if got := ProviderID("provider"); got != "" {
		t.Fatalf("bare provider ProviderID = %q, want empty", got)
	}
	if got := ProviderID("local"); got != "" {
		t.Fatalf("non-provider ProviderID = %q, want empty", got)
	}
}

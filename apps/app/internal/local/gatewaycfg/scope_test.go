package gatewaycfg

import "testing"

func TestScope_DefaultsToLocal(t *testing.T) {
	if got := NewStore(t.TempDir()).Load(); got != ScopeLocal {
		t.Fatalf("default = %q, want local", got)
	}
}

func TestScope_HostMapping(t *testing.T) {
	if ScopeLocal.Host() != "127.0.0.1" {
		t.Fatalf("local host = %q", ScopeLocal.Host())
	}
	if ScopeLAN.Host() != "0.0.0.0" {
		t.Fatalf("lan host = %q", ScopeLAN.Host())
	}
}

func TestScope_SaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := NewStore(dir).Save(ScopeLAN); err != nil {
		t.Fatal(err)
	}
	if got := NewStore(dir).Load(); got != ScopeLAN {
		t.Fatalf("reopened = %q, want lan", got)
	}
}

func TestScope_RejectsUnknown(t *testing.T) {
	if err := NewStore(t.TempDir()).Save("internet"); err == nil {
		t.Fatal("expected error on unknown scope")
	}
}

func TestScope_Normalize(t *testing.T) {
	cases := map[string]Scope{"lan": ScopeLAN, "0.0.0.0": ScopeLAN, "local": ScopeLocal, "": ScopeLocal, "x": ScopeLocal}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q)=%q want %q", in, got, want)
		}
	}
}

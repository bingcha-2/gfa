package takeover

import "testing"

func TestResolvePort(t *testing.T) {
	if got := ResolvePort(SourceRemote, 8788, 19528); got != 8788 {
		t.Fatalf("remote want 8788 got %d", got)
	}
	if got := ResolvePort(SourceLocal, 8788, 19528); got != 19528 {
		t.Fatalf("local want 19528 got %d", got)
	}
}

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

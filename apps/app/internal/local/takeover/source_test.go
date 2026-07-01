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

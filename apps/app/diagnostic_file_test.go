package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteDiagnosticBundleReplacesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "diagnostics.zip")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeDiagnosticBundle(path, []byte("new bundle")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new bundle" {
		t.Fatalf("saved data = %q, want %q", data, "new bundle")
	}
}

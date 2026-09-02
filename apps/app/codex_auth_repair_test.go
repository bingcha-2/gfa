package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRepairCodexAuthMovesUserOwnedAuthToBackup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	authPath := filepath.Join(home, "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"auth_mode":"chatgpt"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := (&App{}).RepairCodexAuth()
	if err != nil {
		t.Fatal(err)
	}
	if result == "" || result == "missing" || result == "restored-managed" {
		t.Fatalf("result = %q, want backup path", result)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("auth.json still exists, stat error = %v", err)
	}
	if data, err := os.ReadFile(result); err != nil || string(data) != `{"auth_mode":"chatgpt"}` {
		t.Fatalf("backup = %q, err = %v", data, err)
	}
}

func TestRepairCodexAuthReportsMissingFile(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	result, err := (&App{}).RepairCodexAuth()
	if err != nil {
		t.Fatal(err)
	}
	if result != "missing" {
		t.Fatalf("result = %q, want missing", result)
	}
}

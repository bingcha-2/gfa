package main

import "testing"

func TestDefaultConfigIncludesCodexAppPath(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.CodexAppPath != "" {
		t.Fatalf("CodexAppPath = %q, want empty default", cfg.CodexAppPath)
	}
}

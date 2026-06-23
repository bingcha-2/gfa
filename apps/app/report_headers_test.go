package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestFilterReportHeaders_DropsSecretsKeepsRest(t *testing.T) {
	h := http.Header{}
	h.Set("User-Agent", "claude-cli/2.0.1 (external, cli)")
	h.Set("X-App", "cli")
	h.Set("Anthropic-Beta", "oauth-2025-04-20")
	h.Set("Authorization", "Bearer sk-ant-secret")
	h.Set("X-Api-Key", "sk-ant-key")
	h.Set("Cookie", "sessionKey=abc")

	out := filterReportHeaders(h)
	var m map[string]string
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("not json: %v (%s)", err, out)
	}
	if _, ok := m["Authorization"]; ok {
		t.Error("Authorization must be dropped")
	}
	if _, ok := m["X-Api-Key"]; ok {
		t.Error("X-Api-Key must be dropped")
	}
	if _, ok := m["Cookie"]; ok {
		t.Error("Cookie must be dropped")
	}
	if m["User-Agent"] == "" || m["X-App"] != "cli" {
		t.Errorf("expected UA + x-app kept, got %v", m)
	}
}

func TestFilterReportHeaders_SkipsOversizedValue(t *testing.T) {
	h := http.Header{}
	h.Set("User-Agent", "claude-cli/2")
	h.Set("X-Big", strings.Repeat("z", 5000))
	out := filterReportHeaders(h)
	if strings.Contains(out, "X-Big") {
		t.Error("oversized header value should be skipped")
	}
	if !strings.Contains(out, "User-Agent") {
		t.Error("normal header should be kept")
	}
}

func TestFilterReportHeaders_EmptyWhenNothingKept(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer x")
	if got := filterReportHeaders(h); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

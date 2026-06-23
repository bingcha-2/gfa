package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func ccHeaders() http.Header {
	h := http.Header{}
	h.Set("User-Agent", "claude-cli/2.0.1 (external, cli)")
	h.Set("x-app", "cli")
	return h
}

func TestDetectClaudeCodeClient_GenuineSystemArray(t *testing.T) {
	body := []byte(`{"model":"claude-opus-4","system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude. Extra preamble..."}],"messages":[]}`)
	genuine, flag := detectClaudeCodeClient(body, ccHeaders())
	if !genuine {
		t.Fatalf("expected genuine, got flag=%q", flag)
	}
	if flag != "" {
		t.Fatalf("expected empty flag for genuine, got %q", flag)
	}
}

func TestDetectClaudeCodeClient_GenuineSystemString(t *testing.T) {
	body := []byte(`{"system":"You are Claude Code, Anthropic's official CLI for Claude.","messages":[]}`)
	genuine, _ := detectClaudeCodeClient(body, ccHeaders())
	if !genuine {
		t.Fatal("system-as-string with signature should be genuine")
	}
}

func TestDetectClaudeCodeClient_MissingSystem(t *testing.T) {
	body := []byte(`{"model":"claude-opus-4","messages":[{"role":"user","content":"hi"}]}`)
	genuine, flag := detectClaudeCodeClient(body, ccHeaders())
	if genuine {
		t.Fatal("missing system must be flagged as non-genuine")
	}
	if flag != "no_cc_system_prompt" {
		t.Fatalf("unexpected flag: %q", flag)
	}
}

func TestDetectClaudeCodeClient_ForeignSystem(t *testing.T) {
	body := []byte(`{"system":[{"type":"text","text":"You are a helpful assistant."}],"messages":[]}`)
	genuine, flag := detectClaudeCodeClient(body, http.Header{}) // also no CC headers
	if genuine {
		t.Fatal("foreign system prompt must be non-genuine")
	}
	// no CC system + no claude-cli UA + no x-app:cli → all three triage reasons
	if flag != "no_cc_system_prompt,ua_not_cli,no_x_app_cli" {
		t.Fatalf("unexpected flag: %q", flag)
	}
}

func TestDetectClaudeCodeClient_SystemIsDecisiveOverHeaders(t *testing.T) {
	// Genuine CC system but odd UA: system is the decisive signal → still genuine.
	body := []byte(`{"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}]}`)
	genuine, _ := detectClaudeCodeClient(body, http.Header{})
	if !genuine {
		t.Fatal("CC system signature should make it genuine regardless of headers")
	}
}

func TestDetectClaudeCodeClient_GarbageBody(t *testing.T) {
	genuine, flag := detectClaudeCodeClient([]byte("not json"), http.Header{})
	if genuine {
		t.Fatal("non-JSON body cannot be genuine")
	}
	if flag == "" {
		t.Fatal("expected a non-empty flag")
	}
}

// --- canonicalUserID ---

func TestCanonicalUserID_Deterministic(t *testing.T) {
	a := canonicalUserID(42)
	b := canonicalUserID(42)
	if a != b {
		t.Fatalf("same accountID should produce same hash: %q vs %q", a, b)
	}
	if len(a) != 64 {
		t.Fatalf("expected 64-char hex (matching Claude Code format), got %d chars: %q", len(a), a)
	}
}

func TestCanonicalUserID_DifferentAccounts(t *testing.T) {
	a := canonicalUserID(1)
	b := canonicalUserID(2)
	if a == b {
		t.Fatal("different accountIDs must produce different hashes")
	}
}

// --- rewriteMetadataUserID ---

func TestRewriteMetadataUserID_ReplacesExisting(t *testing.T) {
	body := []byte(`{"model":"claude-opus-4","metadata":{"user_id":"real-hash-abc"},"messages":[]}`)
	out := rewriteMetadataUserID(body, "canonical-xyz")
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	var meta map[string]string
	json.Unmarshal(parsed["metadata"], &meta)
	if meta["user_id"] != "canonical-xyz" {
		t.Fatalf("expected canonical-xyz, got %q", meta["user_id"])
	}
	// model should survive
	var model string
	json.Unmarshal(parsed["model"], &model)
	if model != "claude-opus-4" {
		t.Fatalf("model field lost: %q", model)
	}
}

func TestRewriteMetadataUserID_NoMetadata_Unchanged(t *testing.T) {
	body := []byte(`{"model":"claude-opus-4","messages":[]}`)
	out := rewriteMetadataUserID(body, "canonical-xyz")
	if string(out) != string(body) {
		t.Fatalf("body without metadata should be unchanged, got %s", out)
	}
}

func TestRewriteMetadataUserID_MetadataWithoutUserID_Unchanged(t *testing.T) {
	body := []byte(`{"metadata":{"other":"val"},"messages":[]}`)
	out := rewriteMetadataUserID(body, "canonical-xyz")
	var parsed map[string]json.RawMessage
	json.Unmarshal(out, &parsed)
	var meta map[string]string
	json.Unmarshal(parsed["metadata"], &meta)
	if _, has := meta["user_id"]; has {
		t.Fatal("should not inject user_id when it didn't exist")
	}
}

func TestRewriteMetadataUserID_EmptyBody(t *testing.T) {
	out := rewriteMetadataUserID(nil, "canonical")
	if out != nil {
		t.Fatal("nil body should return nil")
	}
	out = rewriteMetadataUserID([]byte{}, "canonical")
	if len(out) != 0 {
		t.Fatal("empty body should return empty")
	}
}

func TestRewriteMetadataUserID_InvalidJSON(t *testing.T) {
	body := []byte("not json at all")
	out := rewriteMetadataUserID(body, "canonical")
	if string(out) != string(body) {
		t.Fatal("invalid JSON should pass through unchanged")
	}
}

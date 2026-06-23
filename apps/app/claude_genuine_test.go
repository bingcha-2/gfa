package main

import (
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

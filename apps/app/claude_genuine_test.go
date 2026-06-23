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
	// ccHeaders 只有 claude-cli UA + x-app(无 claude-code beta、无 session-id)→ 指纹不全 → 标记。
	body := []byte(`{"model":"claude-opus-4","messages":[{"role":"user","content":"hi"}]}`)
	genuine, flag := detectClaudeCodeClient(body, ccHeaders())
	if genuine {
		t.Fatal("missing system must be flagged as non-genuine")
	}
	if flag != "no_cc_system_prompt,no_cc_beta,no_session_id" {
		t.Fatalf("unexpected flag: %q", flag)
	}
}

func TestDetectClaudeCodeClient_ForeignSystem(t *testing.T) {
	body := []byte(`{"system":[{"type":"text","text":"You are a helpful assistant."}],"messages":[]}`)
	genuine, flag := detectClaudeCodeClient(body, http.Header{}) // also no CC headers
	if genuine {
		t.Fatal("foreign system prompt must be non-genuine")
	}
	// no CC system + no UA + no beta + no session-id
	if flag != "no_cc_system_prompt,no_ua,no_cc_beta,no_session_id" {
		t.Fatalf("unexpected flag: %q", flag)
	}
}

func TestDetectClaudeCodeClient_GenuineViaFullFingerprint(t *testing.T) {
	// 非 CLI 正版面(VSCode/Agent SDK):整套指纹同时出现(claude-cli UA + claude-code beta + session-id)→ 正版。
	body := []byte(`{"system":[{"type":"text","text":"Custom agent instructions."}],"messages":[]}`)
	h := http.Header{}
	h.Set("User-Agent", "claude-cli/2.1.186 (external, claude-vscode, agent-sdk/0.3.186)")
	h.Set("Anthropic-Beta", "claude-code-20250219,interleaved-thinking-2025-05-14")
	h.Set("X-Claude-Code-Session-Id", "29d35cc5-2993-42fd-8a29-79f96ecc3116")
	genuine, flag := detectClaudeCodeClient(body, h)
	if !genuine {
		t.Fatalf("full genuine fingerprint should pass, got flag=%q", flag)
	}
}

func TestDetectClaudeCodeClient_SingleHeaderNotEnough(t *testing.T) {
	// 单带一个头(无论 session-id 还是 claude-code beta)都【不够】—— 防反代随手塞一个头蒙混。
	body := []byte(`{"system":"Custom","messages":[]}`)
	onlySession := http.Header{}
	onlySession.Set("X-Claude-Code-Session-Id", "29d35cc5-2993-42fd-8a29-79f96ecc3116")
	if g, _ := detectClaudeCodeClient(body, onlySession); g {
		t.Fatal("session-id alone must NOT be genuine")
	}
	onlyBeta := http.Header{}
	onlyBeta.Set("Anthropic-Beta", "claude-code-20250219")
	if g, _ := detectClaudeCodeClient(body, onlyBeta); g {
		t.Fatal("claude-code beta alone must NOT be genuine")
	}
	// claude-cli UA + beta 但缺 session-id 也不够
	twoOfThree := http.Header{}
	twoOfThree.Set("User-Agent", "claude-cli/2.1.186")
	twoOfThree.Set("Anthropic-Beta", "claude-code-20250219")
	if g, _ := detectClaudeCodeClient(body, twoOfThree); g {
		t.Fatal("2 of 3 fingerprint signals must NOT be genuine")
	}
}

func TestDetectClaudeCodeClient_RealVscodeAgentSdk(t *testing.T) {
	// 真实误判样本:VSCode 扩展 + Agent SDK,非 CLI system,但整套指纹齐全 → 不该被标。
	body := []byte(`{"system":[{"type":"text","text":"You are an interactive agent."}],"messages":[]}`)
	h := http.Header{}
	h.Set("User-Agent", "claude-cli/2.1.186 (external, claude-vscode, agent-sdk/0.3.186)")
	h.Set("X-App", "cli")
	h.Set("Anthropic-Beta", "claude-code-20250219,context-management-2025-06-27")
	h.Set("X-Claude-Code-Session-Id", "29d35cc5-2993-42fd-8a29-79f96ecc3116")
	genuine, flag := detectClaudeCodeClient(body, h)
	if !genuine {
		t.Fatalf("genuine VSCode/agent-sdk request must not be flagged, got flag=%q", flag)
	}
}

func TestDetectClaudeCodeClient_ForeignUA(t *testing.T) {
	// 外来客户端(Cline 等):无正版强标记 + 外来 UA → foreign_ua 正向标记。
	body := []byte(`{"system":"You are a helpful assistant.","messages":[]}`)
	h := http.Header{}
	h.Set("User-Agent", "Cline/1.0.0")
	genuine, flag := detectClaudeCodeClient(body, h)
	if genuine {
		t.Fatal("foreign client must be non-genuine")
	}
	if flag != "no_cc_system_prompt,foreign_ua,no_cc_beta,no_session_id" {
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
	out := rewriteMetadataUserID(body, "canonical-xyz", "")
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
	out := rewriteMetadataUserID(body, "canonical-xyz", "")
	if string(out) != string(body) {
		t.Fatalf("body without metadata should be unchanged, got %s", out)
	}
}

func TestRewriteMetadataUserID_MetadataWithoutUserID_Unchanged(t *testing.T) {
	body := []byte(`{"metadata":{"other":"val"},"messages":[]}`)
	out := rewriteMetadataUserID(body, "canonical-xyz", "")
	var parsed map[string]json.RawMessage
	json.Unmarshal(out, &parsed)
	var meta map[string]string
	json.Unmarshal(parsed["metadata"], &meta)
	if _, has := meta["user_id"]; has {
		t.Fatal("should not inject user_id when it didn't exist")
	}
}

func TestRewriteMetadataUserID_PreservesJSONStructure(t *testing.T) {
	// Claude Code 现行格式:只换 device_id,保留 account_uuid / session_id。
	uid := `{"device_id":"REALDEV","account_uuid":"acc-1","session_id":"sess-keep"}`
	body, _ := json.Marshal(map[string]any{
		"metadata": map[string]any{"user_id": uid},
		"messages": []any{},
	})
	out := rewriteMetadataUserID(body, "CANON", "")

	var p struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatal(err)
	}
	var inner struct {
		DeviceID    string `json:"device_id"`
		AccountUUID string `json:"account_uuid"`
		SessionID   string `json:"session_id"`
	}
	if err := json.Unmarshal([]byte(p.Metadata.UserID), &inner); err != nil {
		t.Fatalf("inner user_id must stay valid JSON, got %q", p.Metadata.UserID)
	}
	if inner.DeviceID != "CANON" {
		t.Fatalf("device_id should be canonical, got %q", inner.DeviceID)
	}
	if inner.AccountUUID != "acc-1" {
		t.Fatalf("account_uuid should be preserved, got %q", inner.AccountUUID)
	}
	if inner.SessionID != "sess-keep" {
		t.Fatalf("session_id should be preserved, got %q", inner.SessionID)
	}
}

func TestRewriteMetadataUserID_RewritesAccountUuidWhenProvided(t *testing.T) {
	// 服务端下发母号真 uuid 时:device_id→canonical、account_uuid→真 uuid、session_id 保留。
	uid := `{"device_id":"REALDEV","account_uuid":"client-stale-uuid","session_id":"sess-keep"}`
	body, _ := json.Marshal(map[string]any{
		"metadata": map[string]any{"user_id": uid},
	})
	out := rewriteMetadataUserID(body, "CANON-DEV", "REAL-ACCT-UUID")

	var p struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	json.Unmarshal(out, &p)
	var inner struct {
		DeviceID    string `json:"device_id"`
		AccountUUID string `json:"account_uuid"`
		SessionID   string `json:"session_id"`
	}
	if err := json.Unmarshal([]byte(p.Metadata.UserID), &inner); err != nil {
		t.Fatalf("inner not valid JSON: %q", p.Metadata.UserID)
	}
	if inner.DeviceID != "CANON-DEV" {
		t.Fatalf("device_id should be canonical, got %q", inner.DeviceID)
	}
	if inner.AccountUUID != "REAL-ACCT-UUID" {
		t.Fatalf("account_uuid should be母号真 uuid, got %q", inner.AccountUUID)
	}
	if inner.SessionID != "sess-keep" {
		t.Fatalf("session_id should be preserved, got %q", inner.SessionID)
	}
}

func TestRewriteMetadataUserID_PlainHashStillReplacedWhole(t *testing.T) {
	// 老格式(裸 hash,非 JSON)→ 整段替换成 canonical(回退旧行为)。
	body := []byte(`{"metadata":{"user_id":"real-hash-abc"},"messages":[]}`)
	out := rewriteMetadataUserID(body, "canonical-xyz", "")
	var p struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	json.Unmarshal(out, &p)
	if p.Metadata.UserID != "canonical-xyz" {
		t.Fatalf("plain hash should be wholly replaced, got %q", p.Metadata.UserID)
	}
}

func TestRewriteMetadataUserID_EmptyBody(t *testing.T) {
	out := rewriteMetadataUserID(nil, "canonical", "")
	if out != nil {
		t.Fatal("nil body should return nil")
	}
	out = rewriteMetadataUserID([]byte{}, "canonical", "")
	if len(out) != 0 {
		t.Fatal("empty body should return empty")
	}
}

func TestRewriteMetadataUserID_InvalidJSON(t *testing.T) {
	body := []byte("not json at all")
	out := rewriteMetadataUserID(body, "canonical", "")
	if string(out) != string(body) {
		t.Fatal("invalid JSON should pass through unchanged")
	}
}

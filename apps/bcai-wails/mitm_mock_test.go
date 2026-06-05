package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// 开启「未登录态 mock」后，需要伪造响应的鉴权/账号端点。
func TestMitmShouldMock(t *testing.T) {
	mock := []string{
		"/api/hello",
		"/api/auth/me",
		"/api/claude_code/settings",
		"/api/claude_code/policy_limits",
		"/api/claude_cli/bootstrap",
		"/api/claude_code_penguin_mode",
	}
	for _, p := range mock {
		if !mitmShouldMock(p) {
			t.Errorf("mitmShouldMock(%q) = false, want true", p)
		}
	}
	passthrough := []string{"/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/mcp-registry/v0/servers"}
	for _, p := range passthrough {
		if mitmShouldMock(p) {
			t.Errorf("mitmShouldMock(%q) = true, want false", p)
		}
	}
}

// /api/hello 的 mock 必须是合法 JSON、状态 200，且表达「已登录的 pro 账户」，
// 以骗过未登录客户端的身份校验。
func TestMitmMockHandlerHelloIsLoggedInPro(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "https://api.anthropic.com/api/hello", nil)
	mitmMockHandler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("content-type = %q, want json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("mock body not valid JSON: %v (%s)", err, rec.Body.String())
	}
	if body["has_assigned_account"] != true {
		t.Errorf("mock /api/hello should report has_assigned_account=true, got %v", body["has_assigned_account"])
	}
}

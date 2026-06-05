package main

import (
	"net/http"
	"strings"
)

// ─── 未登录态 mock：伪造「已登录 pro 账户」 ──────────────────────────────────
//
// 默认不启用——登录用户靠透传 /api/hello 等保持自己的真实身份(已跑通)。
// 开启后(SetMockLogin(true))，对未登录用户伪造鉴权/账号端点的响应，让客户端以为
// 已登录 pro，从而无需真实 Claude 账号也能用号池。参考 reclaude buildMockResponse。
//
// 注意：桌面端登录态部分经 host-auth(IPC)下发，未必能仅靠这些 HTTP 端点完全伪造，
// 实际能否让「完全未登录」的桌面端可用，需真机验证。

// mitmShouldMock 判断该端点在 mockLogin 开启时是否伪造响应。
func mitmShouldMock(path string) bool {
	switch {
	case path == "/api/hello",
		path == "/api/auth/me",
		strings.HasPrefix(path, "/api/claude_code/settings"),
		strings.HasPrefix(path, "/api/claude_code/policy_limits"),
		strings.HasPrefix(path, "/api/claude_cli/bootstrap"),
		strings.HasPrefix(path, "/api/claude_code_penguin_mode"):
		return true
	}
	return false
}

// mitmMockHandler 返回伪造鉴权/账号端点的 handler。
func mitmMockHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(mitmMockBody(r.URL.Path)))
	})
}

func mitmMockBody(path string) string {
	switch {
	case path == "/api/hello":
		return `{"account_uuid":"00000000-0000-0000-0000-000000000001","email_address":"user@bcai.local","display_name":"BingchaAI User","billing_type":"pro","has_assigned_account":true,"created_at":"2024-01-01T00:00:00Z"}`
	case path == "/api/auth/me":
		return `{"account_uuid":"00000000-0000-0000-0000-000000000001","email_address":"user@bcai.local"}`
	case strings.HasPrefix(path, "/api/claude_cli/bootstrap"):
		return `{"config":{}}`
	case strings.HasPrefix(path, "/api/claude_code_penguin_mode"):
		return `{"enabled":false}`
	default:
		return `{}`
	}
}

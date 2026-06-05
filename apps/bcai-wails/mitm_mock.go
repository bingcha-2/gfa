package main

import (
	"net/http"
	"strings"
)

// ─── canned 假 pro 身份：零账号兜底(参考 reclaude buildMockResponse) ─────────
//
// 默认路径已改为 entitlement mock(mitm_entitlement.go：保留真登录、只改写付费资格)。
// 本文件的 canned 响应现仅作为「上游 401/403=完全未登录」时的兜底——主要给 Windows/Linux
// 的零账号场景(那边登录态文件式、可彻底伪造)。
//
//   - mitmShouldMock：判定某 path 是否属于资格端点(由 mitmRouter 据此路由到资格 handler)。
//   - mitmMockBody：canned 假 pro 身份/资格响应体，被 entitlement handler 的 401 兜底调用。
//
// macOS 实测确认：桌面端登录态走 safeStorage/钥匙串、不读 .credentials.json，纯伪造登录
// 在 mac 走不通；mac 只能靠 entitlement mock(免费真账号 + 改写付费资格 + 号池出活)。

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

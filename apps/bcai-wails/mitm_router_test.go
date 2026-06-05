package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// MITM 解密后的请求三路分派：/v1/messages*→Claude(换号池 token)；鉴权端点(开启
// mock 时)→mock 伪造登录态；其余→透传真实上游。mockHandler 为 nil 时鉴权端点也走透传
// (登录用户保持自己的真实身份)。
func TestMitmRouterRoutesByPath(t *testing.T) {
	cases := []struct {
		path    string
		mockOn  bool
		want    string // "claude" | "mock" | "forward"
	}{
		{"/v1/messages", true, "claude"},
		{"/v1/messages", false, "claude"},
		{"/v1/messages/count_tokens", false, "claude"},
		{"/api/hello", true, "mock"},          // 开启 mock：伪造登录
		{"/api/hello", false, "forward"},      // 关闭 mock：透传(登录用户保留真实身份)
		{"/api/auth/me", true, "mock"},
		{"/api/auth/me", false, "forward"},
		{"/v1/models", true, "forward"},       // 非鉴权端点，即使开 mock 也透传
		{"/mcp-registry/v0/servers", false, "forward"},
	}
	for _, c := range cases {
		var hit string
		mk := func(name string) http.Handler {
			return http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = name })
		}
		var mockH http.Handler
		if c.mockOn {
			mockH = mk("mock")
		}
		router := mitmRouter(mk("claude"), mockH, mk("forward"))
		req := httptest.NewRequest("POST", "https://api.anthropic.com"+c.path, nil)
		router.ServeHTTP(httptest.NewRecorder(), req)
		if hit != c.want {
			t.Errorf("path=%q mockOn=%v: routed to %q, want %q", c.path, c.mockOn, hit, c.want)
		}
	}
}

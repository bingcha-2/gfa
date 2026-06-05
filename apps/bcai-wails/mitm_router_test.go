package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// MITM 解密后的请求按路径分派：/v1/messages* 交给 Claude 处理器（换号池 token），
// 其余端点(/api/hello、/v1/models 等)透传到真实上游。
func TestMitmRouterRoutesByPath(t *testing.T) {
	cases := []struct {
		path       string
		wantClaude bool
	}{
		{"/v1/messages", true},
		{"/v1/messages/count_tokens", true},
		{"/api/hello", false},
		{"/api/auth/me", false},
		{"/v1/models", false},
		{"/mcp-registry/v0/servers", false},
	}
	for _, c := range cases {
		var hitClaude, hitForward bool
		claudeH := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hitClaude = true })
		forwardH := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hitForward = true })

		router := mitmRouter(claudeH, forwardH)
		req := httptest.NewRequest("POST", "https://api.anthropic.com"+c.path, nil)
		router.ServeHTTP(httptest.NewRecorder(), req)

		if hitClaude != c.wantClaude || hitForward == c.wantClaude {
			t.Errorf("path %q: hitClaude=%v hitForward=%v, wantClaude=%v",
				c.path, hitClaude, hitForward, c.wantClaude)
		}
	}
}

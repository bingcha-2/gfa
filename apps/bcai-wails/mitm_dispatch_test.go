package main

import "testing"

// MITM 只拦截 api.anthropic.com（Claude Code/Cowork 的推理与鉴权端点都在这里），
// 其余域名（claude.ai、CDN、统计等）一律透传，避免不必要的解密。
func TestMitmShouldIntercept(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"api.anthropic.com", true},
		{"api.anthropic.com:443", true}, // 带端口也应识别
		{"claude.ai", false},
		{"a-api.anthropic.com", false},
		{"s-cdn.anthropic.com", false},
		{"statsig.anthropic.com", false},
		{"example.com", false},
		{"", false},
	}
	for _, c := range cases {
		if got := mitmShouldIntercept(c.host); got != c.want {
			t.Errorf("mitmShouldIntercept(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

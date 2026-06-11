package main

import "testing"

// MITM 拦截 api.anthropic.com(推理/eval/directory)与 claude.ai(订阅/付费判定，
// 经 utls 绕 Cloudflare 改写订阅以掀 Code/Cowork 付费墙)；其余域名(子域、CDN、统计)透传。
func TestMitmShouldIntercept(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"api.anthropic.com", true},
		{"api.anthropic.com:443", true}, // 带端口也应识别
		{"claude.ai", true},
		{"claude.ai:443", true},
		{"a.claude.ai", false}, // 子域(分析/遥测)仍透传
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

package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsBlockedClaudeModel(t *testing.T) {
	blocked := []string{
		"deepseek-v4-pro",       // 用户日志里真实出现的第三方模型
		"deepseek-v4-pro[1m]",   // 带中转别名后缀
		"qwen-max",              // 国产:通义千问
		"qwen2.5-72b-instruct",  // 国产
		"kimi-k2",               // 国产:月之暗面
		"moonshot-v1-128k",      // 国产:月之暗面官方 id
		"glm-4.6",               // 国产:智谱
		"doubao-seed-1-6",       // 国产:豆包/火山
		"ernie-4.5",             // 国产:文心
		"hunyuan-large",         // 国产:混元
		"gpt-4o",                // OpenAI
		"gemini-2.5-pro",        // Google
		"grok-4",                // xAI
		"claude-opus-4-8[1m]",   // 真 claude 前缀但带非法别名后缀 → 公开 API 不认
		"deepseek-claude-proxy", // 塞了 claude 做诱饵,黑名单仍拦
		"random-model-name",     // 不含 claude
	}
	for _, m := range blocked {
		if ok, _ := isBlockedClaudeModel(m); !ok {
			t.Errorf("isBlockedClaudeModel(%q) = false, want blocked", m)
		}
	}

	allowed := []string{
		"claude-opus-4-20250514",
		"claude-sonnet-4-5-20250929",
		"claude-3-5-haiku-20241022",
		"claude-opus-4-8",
		"", // 空:由上层回落默认模型,不在此拦
	}
	for _, m := range allowed {
		if ok, why := isBlockedClaudeModel(m); ok {
			t.Errorf("isBlockedClaudeModel(%q) = true (%s), want allowed", m, why)
		}
	}
}

// 非法模型必须在【lease 之前】被本地拒绝:不取号、不发上游。
func TestClaudeProxyBlocksIllegalModelBeforeLease(t *testing.T) {
	p := &ClaudeProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*ClaudeTokenLease, error) {
			t.Fatal("非法模型不应触发 lease(取号)")
			return nil, nil
		},
		upstreamClient: func(string) *http.Client {
			t.Fatal("非法模型不应发往上游")
			return nil
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4-pro[1m]","stream":true,"messages":[]}`))
	req.Header.Set("anthropic-version", "2023-06-01")
	rw := httptest.NewRecorder()

	p.ServeHTTP(rw, req, "card-1", "dev-1", "")

	if rw.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rw.Code)
	}
	msg := decodeClaudeProxyErrorMessage(t, rw.Body.Bytes())
	if !strings.Contains(msg, "deepseek-v4-pro") {
		t.Fatalf("错误信息应点名被拦模型,实际: %q", msg)
	}
	if !strings.Contains(msg, "重启") {
		t.Fatalf("错误信息应提示重启 CLI/IDE,实际: %q", msg)
	}
}

// 合法 claude 模型不受影响(能进入 lease 阶段)。
func TestClaudeProxyAllowsLegitModelReachesLease(t *testing.T) {
	leased := false
	p := &ClaudeProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*ClaudeTokenLease, error) {
			leased = true
			// 返回错误即可(不必真连上游):只验证合法模型能走到 lease。
			return nil, errors.New("stop after lease reached")
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-opus-4-20250514","stream":true,"messages":[]}`))
	rw := httptest.NewRecorder()
	p.ServeHTTP(rw, req, "card-1", "dev-1", "")
	if !leased {
		t.Fatal("合法 claude 模型应能进入 lease 阶段")
	}
}

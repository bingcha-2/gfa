package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsOpenAIImageRequest(t *testing.T) {
	positive := []string{
		"/v1/images/generations",
		"/v1/images/edits",
		"/v1/images/variations",
		"/V1/Images/Edits", // 大小写不敏感
	}
	for _, path := range positive {
		if !isOpenAIImageRequest(path) {
			t.Fatalf("isOpenAIImageRequest(%q) = false, want true", path)
		}
	}

	negative := []string{
		"/v1/responses",
		"/v1/chat/completions",
		"/v1/images", // 无子路径
		"/backend-api/codex/responses",
		"/health",
	}
	for _, path := range negative {
		if isOpenAIImageRequest(path) {
			t.Fatalf("isOpenAIImageRequest(%q) = true, want false", path)
		}
	}
}

// 核心行为:与 /v1/responses、/v1/models 同一套逻辑 —— 租号 → 注入 OAuth 令牌 + ChatGPT-Account-Id
// → 原样 /v1/images/edits 路径发到 chatgpt.com,响应原样回写。
// 断言:上游路径不加 backend-api 前缀;Authorization 换成租来的令牌(非客户端本地 token);
// ChatGPT-Account-Id 从令牌解出;multipart Content-Type 与请求体原样透传。
// /v1/images/* REST 端点在 chatgpt.com codex 后端不存在(实测只回网页 HTML)。
// 生图改由 responses 内联工具实现,故 ServeImages 明确回 404,绝不租号/转发 HTML。
func TestCodexServeImagesReturns404NotHTML(t *testing.T) {
	proxy := &CodexProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			t.Fatal("图像端点不应发起租号(已废弃透传)")
			return nil, nil
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"a cat"}`))
	rec := httptest.NewRecorder()

	proxy.ServeImages(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(strings.ToLower(body), "<html") || strings.Contains(body, "<!DOCTYPE") {
		t.Fatalf("绝不能把网页 HTML 回给客户端:\n%s", body)
	}
	// 应是 JSON 错误,提示走 responses 内联。
	if !strings.Contains(body, "/v1/responses") {
		t.Fatalf("404 应提示改用 responses 内联生图,got: %s", body)
	}
}

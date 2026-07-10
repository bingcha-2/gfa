package main

import (
	"io"
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
func TestCodexServeImagesInjectsAndForwards(t *testing.T) {
	const accountID = "acct-img-77"
	const multipartCT = "multipart/form-data; boundary=----imgboundary"
	const reqBody = "------imgboundary\r\nfake image bytes\r\n------imgboundary--"

	var gotAuth, gotCT, gotBody, gotPath, gotAccountHdr string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotAccountHdr = r.Header.Get("ChatGPT-Account-Id")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"AAAA"}]}`)
	}))
	defer upstream.Close()

	leasedToken := forgeFakeCodexJWT(accountID)
	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			if card != "codex-card" || deviceId != "device-a" {
				t.Fatalf("lease args card=%q deviceId=%q", card, deviceId)
			}
			return &CodexTokenLease{AccessToken: leasedToken, AccountId: 42}, nil
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", strings.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer local-fake-token")
	req.Header.Set("Content-Type", multipartCT)
	rec := httptest.NewRecorder()

	proxy.ServeImages(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"data":[{"b64_json":"AAAA"}]}` {
		t.Fatalf("client body = %s", got)
	}
	if gotPath != "/v1/images/edits" {
		t.Fatalf("upstream path = %q, want /v1/images/edits (no backend-api prefix)", gotPath)
	}
	if gotAuth != "Bearer "+leasedToken {
		t.Fatalf("upstream Authorization = %q, want injected leased token", gotAuth)
	}
	if gotAccountHdr != accountID {
		t.Fatalf("ChatGPT-Account-Id = %q, want %q", gotAccountHdr, accountID)
	}
	if gotCT != multipartCT {
		t.Fatalf("upstream Content-Type = %q, want preserved multipart", gotCT)
	}
	if gotBody != reqBody {
		t.Fatalf("upstream body = %q, want preserved", gotBody)
	}
}

// 未绑定卡密时返回 503(绝不 401,避免 codex 客户端触发重新登录)。
func TestCodexServeImagesNoCardReturns503(t *testing.T) {
	proxy := &CodexProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			t.Fatal("未绑定卡密不应发起租号")
			return nil, nil
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", strings.NewReader("{}"))
	rec := httptest.NewRecorder()

	proxy.ServeImages(rec, req, "", "device-a", "direct")

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

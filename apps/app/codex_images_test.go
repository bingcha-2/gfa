package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestIsOpenAIImageRequest(t *testing.T) {
	for _, p := range []string{"/v1/images/generations", "/v1/images/edits", "/V1/IMAGES/VARIATIONS"} {
		if !isOpenAIImageRequest(p) {
			t.Fatalf("%q 应识别为图像请求", p)
		}
	}
	for _, p := range []string{"/v1/responses", "/v1/models", "/v1/images/other"} {
		if isOpenAIImageRequest(p) {
			t.Fatalf("%q 不应识别为图像请求", p)
		}
	}
}

// 核心:/v1/images/generations 被翻译成 responses+生图工具打上游,拿回 base64 图,
// 翻成图像接口 JSON 返回。上游只是 mock 的 SSE,验证的是【翻译】而非真出图。
func TestCodexServeImagesTranslatesToResponses(t *testing.T) {
	var gotPath, gotBody, gotAuth, gotAccept string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"result\":\"iVBOR-fake-png\",\"output_format\":\"png\",\"revised_prompt\":\"a cute cat fishing\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15},\"tool_usage\":{\"image_gen\":{\"output_tokens\":200}}}}\n\n")
	}))
	defer upstream.Close()

	leased := forgeFakeCodexJWT("acct-img-1")
	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*CodexTokenLease, error) {
			if card != "codex-card" {
				t.Fatalf("lease card=%q", card)
			}
			return &CodexTokenLease{AccessToken: leased, AccountId: 7}, nil
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"a cute cat fishing","size":"1024x1024"}`))
	rec := httptest.NewRecorder()
	proxy.ServeImages(rec, req, "codex-card", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// 上游收到的是翻译后的 responses 请求。
	if gotPath != "/backend-api/codex/responses" {
		t.Fatalf("上游路径 = %q, want /backend-api/codex/responses", gotPath)
	}
	if gotAuth != "Bearer "+leased {
		t.Fatalf("上游未注入租号 token: %q", gotAuth)
	}
	if gotAccept != "text/event-stream" {
		t.Fatalf("上游 Accept = %q, want SSE", gotAccept)
	}
	if !strings.Contains(gotBody, `"image_generation"`) || !strings.Contains(gotBody, "a cute cat fishing") {
		t.Fatalf("翻译后的 body 应含生图工具+prompt:\n%s", gotBody)
	}
	// 返回给客户端的是图像接口 JSON。
	out := rec.Body.Bytes()
	if b64 := gjson.GetBytes(out, "data.0.b64_json").String(); b64 != "iVBOR-fake-png" {
		t.Fatalf("返回的 b64_json = %q, want iVBOR-fake-png; body=%s", b64, out)
	}
	if rp := gjson.GetBytes(out, "data.0.revised_prompt").String(); rp != "a cute cat fishing" {
		t.Fatalf("revised_prompt = %q", rp)
	}
}

// 套餐中转模式没有母号 token。生图仍应使用租约下发的 URL/API Key，并兼容
// NewAPI 已返回可用 partial_image、随后又错误发送 response.failed 的实际行为。
func TestCodexServeImagesUsesServerRelayAndKeepsLastPartial(t *testing.T) {
	var gotPath, gotAuth, gotAccountID, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotAccountID = r.Header.Get("ChatGPT-Account-Id")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: response.image_generation_call.partial_image\n")
		_, _ = io.WriteString(w, `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"iVBOR-relay-partial","partial_image_index":0}`+"\n\n")
		_, _ = io.WriteString(w, "event: response.failed\n")
		_, _ = io.WriteString(w, `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"upstream_error"}}}`+"\n\n")
	}))
	defer upstream.Close()

	proxy := &CodexProxy{
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			return &CodexTokenLease{
				Mode: "relay",
				Relay: &CodexLeaseRelay{
					BaseURL: upstream.URL,
					APIKey:  "server-relay-key",
					ModelMap: map[string]string{
						codexImagesMainModel: "gpt-5.6-sol",
					},
				},
			}, nil
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"relay image"}`))
	rec := httptest.NewRecorder()
	proxy.ServeImages(rec, req, "subscription-key", "device-a", "direct")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/responses" {
		t.Fatalf("relay path = %q, want /responses", gotPath)
	}
	if gotAuth != "Bearer server-relay-key" {
		t.Fatalf("relay auth = %q", gotAuth)
	}
	if gotAccountID != "" {
		t.Fatalf("中转请求不应发送 ChatGPT-Account-Id, got %q", gotAccountID)
	}
	if gjson.Get(gotBody, "model").String() != "gpt-5.6-sol" {
		t.Fatalf("主持模型未按中转映射改写: %s", gotBody)
	}
	if got := gjson.GetBytes(rec.Body.Bytes(), "data.0.b64_json").String(); got != "iVBOR-relay-partial" {
		t.Fatalf("未保留最后一张 partial image: %q; body=%s", got, rec.Body.String())
	}
}

// 上游没返回图 → 502(不把空/坏响应当成功)。
func TestCodexServeImagesNoImageReturns502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\"}]}}\n\n")
	}))
	defer upstream.Close()
	proxy := &CodexProxy{
		upstreamBase: upstream.URL,
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("a"), AccountId: 1}, nil
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"x"}`))
	rec := httptest.NewRecorder()
	proxy.ServeImages(rec, req, "codex-card", "device-a", "direct")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

// 未绑定卡密 → 503(绝不 401)。
func TestCodexServeImagesNoCardReturns503(t *testing.T) {
	proxy := &CodexProxy{leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
		t.Fatal("未绑定卡密不应租号")
		return nil, nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"x"}`))
	rec := httptest.NewRecorder()
	proxy.ServeImages(rec, req, "", "device-a", "direct")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

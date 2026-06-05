package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func entitlementTestHandler(t *testing.T, upstream *httptest.Server) http.Handler {
	t.Helper()
	return mitmEntitlementHandler(upstream.URL, upstream.Client().Transport)
}

func doEntitlement(t *testing.T, h http.Handler, path string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest("GET", "https://api.anthropic.com"+path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var m map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("响应非 JSON: %v (body=%s)", err, rec.Body.String())
	}
	return rec.Code, m
}

// 真账号(免费)响应 → 改写付费字段为 pro，但保留真实身份。
func TestEntitlement_PatchPreservesIdentity(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"account_uuid":"REAL-UUID","email_address":"me@real.com","billing_type":"free","has_assigned_account":false}`))
	}))
	defer upstream.Close()

	code, m := doEntitlement(t, entitlementTestHandler(t, upstream), "/api/hello")
	if code != 200 {
		t.Fatalf("want 200, got %d", code)
	}
	// 身份保留
	if m["account_uuid"] != "REAL-UUID" || m["email_address"] != "me@real.com" {
		t.Fatalf("真实身份被改掉了: %v", m)
	}
	// 付费资格改写
	if m["billing_type"] != "pro" {
		t.Fatalf("billing_type 应改写为 pro, got %v", m["billing_type"])
	}
	if m["has_assigned_account"] != true {
		t.Fatalf("has_assigned_account 应改写为 true, got %v", m["has_assigned_account"])
	}
}

// 嵌套层级的订阅字段也应被改写。
func TestEntitlement_PatchNested(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"account":{"subscriptionType":"free","nested":{"has_claude_pro":false}}}`))
	}))
	defer upstream.Close()

	_, m := doEntitlement(t, entitlementTestHandler(t, upstream), "/api/claude_code/settings")
	acct := m["account"].(map[string]interface{})
	if acct["subscriptionType"] != "pro" {
		t.Fatalf("嵌套 subscriptionType 应改写为 pro, got %v", acct["subscriptionType"])
	}
	nested := acct["nested"].(map[string]interface{})
	if nested["has_claude_pro"] != true {
		t.Fatalf("深层 has_claude_pro 应改写为 true, got %v", nested["has_claude_pro"])
	}
}

// 上游 401(完全未登录)→ 退回 canned 假 pro 身份、状态码改 200。
func TestEntitlement_UnauthorizedFallbackToCanned(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer upstream.Close()

	code, m := doEntitlement(t, entitlementTestHandler(t, upstream), "/api/hello")
	if code != 200 {
		t.Fatalf("401 应被兜底成 200, got %d", code)
	}
	if m["billing_type"] != "pro" {
		t.Fatalf("canned 兜底应是 pro 身份, got %v", m)
	}
}

// gzip 压缩的上游响应也应能解压、改写、回写明文。
func TestEntitlement_GzipResponse(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write([]byte(`{"billing_type":"free"}`))
		_ = zw.Close()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(buf.Bytes())
	}))
	defer upstream.Close()

	req := httptest.NewRequest("GET", "https://api.anthropic.com/api/hello", nil)
	rec := httptest.NewRecorder()
	entitlementTestHandler(t, upstream).ServeHTTP(rec, req)

	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("回写应为明文，Content-Encoding 应清空, got %q", enc)
	}
	if !strings.Contains(rec.Body.String(), `"pro"`) {
		t.Fatalf("gzip 响应应被解压并改写为 pro, got %s", rec.Body.String())
	}
}

// 非白名单字段不应被误改。
func TestEntitlement_LeavesUnknownFieldsAlone(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"display_name":"Alice","some_flag":false,"count":3}`))
	}))
	defer upstream.Close()

	_, m := doEntitlement(t, entitlementTestHandler(t, upstream), "/api/hello")
	if m["display_name"] != "Alice" || m["some_flag"] != false || m["count"] != float64(3) {
		t.Fatalf("非资格字段被误改: %v", m)
	}
}

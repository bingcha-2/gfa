package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func withCodexAPIBase(t *testing.T, base string) {
	t.Helper()
	old := CODEX_API_BASE
	CODEX_API_BASE = base
	t.Cleanup(func() { CODEX_API_BASE = old })
}

func TestCodexReportCarriesContextTokens(t *testing.T) {
	received := make(chan map[string]interface{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		received <- body
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))
	defer srv.Close()
	withCodexAPIBase(t, srv.URL)
	l := &CodexLeaser{}
	l.ReportUsage("card-1", "dev-1", ReportDetails{
		StatusCode: 200, ModelKey: "gpt-5.6-sol", InputTokens: 300_000,
		ContextTokens: 300_000, RawTotalTokens: 300_000, BillableTotalTokens: 300_000,
	}, "", &CodexTokenLease{LeaseId: "lease-context", AccountId: 1})
	select {
	case body := <-received:
		if body["contextTokens"] != float64(300_000) {
			t.Fatalf("context payload = %#v", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for report")
	}
}

// codex 硬额度 429(token limit exceeded)→ 结构化 *QuotaExhaustedError,不重试、不挡路。
// 与 claude/antigravity 同一套行为(三家一致)。
func TestCodexHardLimitReturnsStructuredErrorAndDoesNotBlock(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":           false,
			"error":        "Access key Codex · GPT token limit exceeded (5200/1000 tokens/5h)",
			"retryAfterMs": 3 * 60 * 60 * 1000,
		})
	}))
	defer srv.Close()
	withCodexAPIBase(t, srv.URL)

	l := &CodexLeaser{}
	_, err := l.LeaseToken("card-1", "dev", true, nil, "")
	qe, ok := err.(*QuotaExhaustedError)
	if !ok {
		t.Fatalf("codex 硬额度应返回 *QuotaExhaustedError, got %T: %v", err, err)
	}
	if qe.RetryAfterMs != 3*60*60*1000 {
		t.Fatalf("RetryAfterMs = %d", qe.RetryAfterMs)
	}

	// 不挡路:再调一次仍真打上游(无熔断,允许用户/IDE 自己再试)。
	_, _ = l.LeaseToken("card-1", "dev", true, nil, "")
	if hits != 2 {
		t.Fatalf("codex must not block; want 2 upstream hits, got %d", hits)
	}
}

// codex 同样从 lease 解析出口代理,但策略 optional(egressRequired=false):绑了就走、没绑本地直连。
func TestCodexLeaseTokenParsesEgressInfo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":              true,
			"accessToken":     "codex-leased",
			"accountId":       9,
			"leaseId":         "lease-2",
			"accountProxyUrl": "http://res.codex:8080",
			"egressRequired":  false,
		})
	}))
	defer srv.Close()
	withCodexAPIBase(t, srv.URL)

	l := &CodexLeaser{}
	lease, err := l.LeaseToken("card-1", "dev", true, nil, "")
	if err != nil {
		t.Fatalf("LeaseToken: %v", err)
	}
	if lease.ProxyURL != "http://res.codex:8080" {
		t.Fatalf("lease.ProxyURL = %q, want bound proxy", lease.ProxyURL)
	}
	if lease.EgressRequired {
		t.Fatalf("codex lease must be optional (EgressRequired=false)")
	}
}

func TestApplyCodexReportResponseIgnoresLegacyFairShare(t *testing.T) {
	clearBoundFractionsForTest()
	body, _ := json.Marshal(map[string]interface{}{
		"ok": true,
		"accountBuckets": map[string]interface{}{
			"codex-gpt": map[string]interface{}{"fraction": 0.29, "resetAt": float64(30_000)},
		},
		"weeklyFairShareQuota": map[string]interface{}{
			"codex-gpt": map[string]interface{}{"fraction": 0.37, "resetAt": float64(70_000)},
		},
	})
	applyCodexReportResponse(body)
	if fairShareCacheHasForTest("codex-gpt") {
		t.Fatal("Codex legacy fair-share response must not enter local enforcement")
	}
}

func TestCodexLeaseSyncsAccessKeyStatusToMainLeaser(t *testing.T) {
	prev := globalLeaser
	globalLeaser = &Leaser{}
	t.Cleanup(func() { globalLeaser = prev })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":          true,
			"accessToken": "codex-leased",
			"accountId":   11,
			"leaseId":     "lease-codex",
			"accessKeyStatus": map[string]interface{}{
				"quotaMode":     "static",
				"products":      []interface{}{"codex"},
				"shareSeats":    2,
				"shareCapacity": 8,
				"buckets": []interface{}{
					map[string]interface{}{"bucket": "codex-gpt", "used": 5, "limit": 20},
				},
			},
		})
	}))
	defer srv.Close()
	withCodexAPIBase(t, srv.URL)

	l := &CodexLeaser{}
	if _, err := l.LeaseToken("card-1", "dev", true, map[string]interface{}{"modelKey": "gpt-5-codex"}, ""); err != nil {
		t.Fatalf("LeaseToken: %v", err)
	}

	status := GetLeaser().GetStatus()
	aks, ok := status["accessKeyStatus"].(map[string]interface{})
	if !ok {
		t.Fatalf("main leaser accessKeyStatus not synced: %#v", status["accessKeyStatus"])
	}
	if aks["quotaMode"] != "static" {
		t.Fatalf("quotaMode = %v, want static", aks["quotaMode"])
	}
	if got := aks["products"].([]interface{})[0]; got != "codex" {
		t.Fatalf("products[0] = %v, want codex", got)
	}
	if got := aks["shareSeats"]; got != float64(2) {
		t.Fatalf("shareSeats = %v, want 2", got)
	}
}

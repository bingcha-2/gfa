package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// ─── fetchHealthViaToken Tests ───────────────────────────────────────────

func TestFetchHealthViaToken_ParsesCreditsAndPlanType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 验证请求头
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("expected Bearer test-token, got %s", r.Header.Get("Authorization"))
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		resp := map[string]interface{}{
			"paidTier": map[string]interface{}{
				"id":   "AI_ULTRA",
				"name": "Google One AI Ultra",
				"availableCredits": []interface{}{
					map[string]interface{}{
						"creditType":                  "GOOGLE_ONE_AI",
						"creditAmount":                2380.0,
						"minimumCreditAmountForUsage": 100.0,
					},
				},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	credits, planType := fetchHealthViaTokenWithEndpoint(server.URL, "test-token", "")

	if planType != "ultra" {
		t.Errorf("expected ultra, got %s", planType)
	}
	if credits == nil {
		t.Fatal("credits is nil")
	}
	if credits.CreditAmount != 2380 {
		t.Errorf("expected 2380, got %.0f", credits.CreditAmount)
	}
	if !credits.Available {
		t.Error("expected available=true")
	}
	if credits.PaidTierID != "AI_ULTRA" {
		t.Errorf("expected AI_ULTRA, got %s", credits.PaidTierID)
	}
	if credits.MinCreditAmount != 100 {
		t.Errorf("expected 100, got %.0f", credits.MinCreditAmount)
	}
	if !credits.Known {
		t.Error("expected known=true")
	}
}

func TestFetchHealthViaToken_FreeTier(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 无 paidTier → free tier
		json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer server.Close()

	credits, planType := fetchHealthViaTokenWithEndpoint(server.URL, "test-token", "")

	if planType != "free" {
		t.Errorf("expected free, got %s", planType)
	}
	if credits != nil && credits.CreditAmount != 0 {
		t.Errorf("expected 0 credits for free tier, got %.0f", credits.CreditAmount)
	}
}

func TestFetchHealthViaToken_PremiumNoCreditField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// paidTier without availableCredits (Pro/Premium 套餐)
		resp := map[string]interface{}{
			"paidTier": map[string]interface{}{
				"id":   "AI_PREMIUM",
				"name": "Google One AI Premium",
				// 注意：没有 availableCredits
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	credits, planType := fetchHealthViaTokenWithEndpoint(server.URL, "test-token", "")

	if planType != "premium" {
		t.Errorf("expected premium, got %s", planType)
	}
	if credits == nil {
		t.Fatal("credits should not be nil for premium (known=true, available=false)")
	}
	if !credits.Known {
		t.Error("expected known=true for premium")
	}
	if credits.Available {
		t.Error("expected available=false for premium without credits")
	}
}

func TestFetchHealthViaToken_HttpError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer server.Close()

	credits, planType := fetchHealthViaTokenWithEndpoint(server.URL, "test-token", "")

	if planType != "free" {
		t.Errorf("expected free on error, got %s", planType)
	}
	if credits != nil {
		t.Error("expected nil credits on HTTP error")
	}
}

// ─── fetchModelsViaToken Tests ──────────────────────────────────────────

func TestFetchModelsViaToken_ParsesModelQuota(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("wrong auth header")
		}
		// 验证 body 包含 project
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["project"] != "proj-123" {
			t.Errorf("expected project=proj-123, got %s", body["project"])
		}

		resp := map[string]interface{}{
			"models": map[string]interface{}{
				"gemini-2.5-pro": map[string]interface{}{
					"quotaInfo": map[string]interface{}{
						"remainingFraction": 0.85,
					},
				},
				"claude-sonnet-4": map[string]interface{}{
					"quotaInfo": map[string]interface{}{
						"remainingFraction": 0.0,
					},
				},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	models := fetchModelsViaTokenWithEndpoint(server.URL, "test-token", "proj-123", "")

	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(models))
	}
	if models["gemini-2.5-pro"].RemainingFraction != 0.85 {
		t.Errorf("gemini fraction: expected 0.85, got %f", models["gemini-2.5-pro"].RemainingFraction)
	}
	if models["claude-sonnet-4"].RemainingFraction != 0.0 {
		t.Errorf("claude fraction: expected 0.0, got %f", models["claude-sonnet-4"].RemainingFraction)
	}
}

func TestFetchModelsViaToken_EmptyModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer server.Close()

	models := fetchModelsViaTokenWithEndpoint(server.URL, "test-token", "proj-123", "")
	if models != nil {
		t.Errorf("expected nil for empty response, got %v", models)
	}
}

func TestFetchModelsViaToken_HttpError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
	}))
	defer server.Close()

	models := fetchModelsViaTokenWithEndpoint(server.URL, "test-token", "proj-123", "")
	if models != nil {
		t.Errorf("expected nil on HTTP error, got %v", models)
	}
}

// ─── fetchAccountQuotaAsync Tests ───────────────────────────────────────

func TestFetchAccountQuotaAsync_CASPreventsConcurrent(t *testing.T) {
	l := GetLeaser()

	// 模拟已有 token
	l.mu.Lock()
	l.cachedToken = &TokenLease{
		AccessToken: "test",
		ProjectId:   "proj",
		AccountId:   1,
		ExpiresAt:   time.Now().Add(10 * time.Minute).UnixMilli(),
	}
	l.mu.Unlock()

	// 先设置 CAS flag = 1（模拟已在查询中）
	atomic.StoreInt32(&l.quotaFetching, 1)

	// 应该被 CAS 拦截，立即返回
	l.fetchAccountQuotaAsync()

	// 验证 snapshot 不会被更新（因为被 CAS 拦住了）
	l.mu.RLock()
	snapshot := l.cachedQuotaSnapshot
	l.mu.RUnlock()
	if snapshot != nil {
		t.Error("expected nil snapshot when CAS blocks")
	}

	// 清理
	atomic.StoreInt32(&l.quotaFetching, 0)
	l.mu.Lock()
	l.cachedToken = nil
	l.mu.Unlock()
}

func TestFetchAccountQuotaAsync_SkipsExpiredToken(t *testing.T) {
	l := GetLeaser()

	// 设置即将过期的 token（剩余 <2min）
	l.mu.Lock()
	l.cachedToken = &TokenLease{
		AccessToken: "test",
		ProjectId:   "proj",
		AccountId:   1,
		ExpiresAt:   time.Now().Add(60 * time.Second).UnixMilli(), // 仅 1 分钟
	}
	l.cachedQuotaSnapshot = nil
	l.mu.Unlock()

	l.fetchAccountQuotaAsync()

	l.mu.RLock()
	snapshot := l.cachedQuotaSnapshot
	l.mu.RUnlock()
	if snapshot != nil {
		t.Error("expected nil snapshot for expired token")
	}

	// 清理
	l.mu.Lock()
	l.cachedToken = nil
	l.mu.Unlock()
}

func TestFetchAccountQuotaAsync_SkipsNoToken(t *testing.T) {
	l := GetLeaser()

	l.mu.Lock()
	l.cachedToken = nil
	l.cachedQuotaSnapshot = nil
	l.mu.Unlock()

	l.fetchAccountQuotaAsync()

	l.mu.RLock()
	snapshot := l.cachedQuotaSnapshot
	l.mu.RUnlock()
	if snapshot != nil {
		t.Error("expected nil snapshot when no token")
	}
}

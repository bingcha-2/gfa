package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ─── PostRequestHealthRefresh Tests ─────────────────────────────────────

func TestPostRequestHealthRefresh_SkipsDisabledAccount(t *testing.T) {
	pool := &AccountPool{
		accounts: map[int]*AccountEntry{
			1: {ID: 1, Email: "test@example.com", Enabled: false},
		},
	}
	// 对 disabled 账号不应启动刷新
	pool.PostRequestHealthRefresh(1)
	// 验证 healthRefreshing flag 没有被设置
	if atomic.LoadInt32(&pool.accounts[1].healthRefreshing) != 0 {
		t.Error("should not start refresh for disabled account")
	}
}

func TestPostRequestHealthRefresh_SkipsUnknownAccount(t *testing.T) {
	pool := &AccountPool{
		accounts: map[int]*AccountEntry{},
	}
	// 不存在的账号不应 panic
	pool.PostRequestHealthRefresh(999)
}

func TestPostRequestHealthRefresh_CASPreventsConcurrent(t *testing.T) {
	pool := &AccountPool{
		accounts: map[int]*AccountEntry{
			1: {ID: 1, Email: "test@example.com", Enabled: true},
		},
	}

	// 手动设置 CAS flag = 1（模拟已在刷新中）
	atomic.StoreInt32(&pool.accounts[1].healthRefreshing, 1)

	// 第二次调用应被 CAS 拦截
	pool.PostRequestHealthRefresh(1)

	// 等一小会确保 goroutine 有机会启动（如果 CAS 没拦住的话）
	time.Sleep(50 * time.Millisecond)

	// flag 应仍然为 1（未被重置，因为第二次调用没有启动 goroutine）
	if atomic.LoadInt32(&pool.accounts[1].healthRefreshing) != 1 {
		t.Error("CAS should prevent concurrent refresh")
	}

	// 清理
	atomic.StoreInt32(&pool.accounts[1].healthRefreshing, 0)
}

// ─── GetActiveAccountInfo Tests ─────────────────────────────────────────

func TestGetActiveAccountInfo_ReturnsNilWhenNoActive(t *testing.T) {
	pool := &AccountPool{
		accounts:        map[int]*AccountEntry{},
		activeAccountId: 0,
	}
	result := pool.GetActiveAccountInfo()
	if result != nil {
		t.Error("expected nil when no active account")
	}
}

func TestGetActiveAccountInfo_ReturnsNilWhenIdNotFound(t *testing.T) {
	pool := &AccountPool{
		accounts:        map[int]*AccountEntry{},
		activeAccountId: 999,
	}
	result := pool.GetActiveAccountInfo()
	if result != nil {
		t.Error("expected nil when account id not found")
	}
}

func TestGetActiveAccountInfo_ReturnsSummary(t *testing.T) {
	now := time.Now()
	pool := &AccountPool{
		mu:              sync.RWMutex{},
		activeAccountId: 1,
		accounts: map[int]*AccountEntry{
			1: {
				ID:               1,
				Email:            "alice@example.com",
				Alias:            "主号",
				PlanType:         "ultra",
				Enabled:          true,
				creditAmount:     2380,
				minCreditAmount:  100,
				creditsKnown:     true,
				creditsAvailable: true,
				paidTierID:       "AI_ULTRA",
				quotaGroups: []QuotaGroup{
					{Provider: "gemini", Percent: 85, ModelCount: 3, BlockedCount: 0},
				},
				quotaRefreshedAt: now,
			},
		},
	}

	result := pool.GetActiveAccountInfo()
	if result == nil {
		t.Fatal("expected non-nil")
	}
	if result.AccountId != 1 {
		t.Errorf("expected accountId=1, got %d", result.AccountId)
	}
	if result.PlanType != "ultra" {
		t.Errorf("expected ultra, got %s", result.PlanType)
	}
	// Email 应该被脱敏
	if result.Email == "alice@example.com" {
		t.Error("email should be masked")
	}
	if result.Alias != "主号" {
		t.Errorf("expected alias=主号, got %s", result.Alias)
	}
	if result.Credits == nil {
		t.Fatal("expected credits non-nil")
	}
	if result.Credits.CreditAmount != 2380 {
		t.Errorf("expected 2380, got %.0f", result.Credits.CreditAmount)
	}
	if !result.Credits.Available {
		t.Error("expected available=true")
	}
	if result.Credits.PaidTierID != "AI_ULTRA" {
		t.Errorf("expected AI_ULTRA, got %s", result.Credits.PaidTierID)
	}
	if len(result.QuotaGroups) != 1 {
		t.Fatalf("expected 1 quota group, got %d", len(result.QuotaGroups))
	}
	if result.QuotaGroups[0].Provider != "gemini" {
		t.Errorf("expected gemini, got %s", result.QuotaGroups[0].Provider)
	}
	if result.QuotaRefreshedAt != now.UnixMilli() {
		t.Errorf("quotaRefreshedAt mismatch")
	}
}

func TestGetActiveAccountInfo_NoCredits(t *testing.T) {
	pool := &AccountPool{
		mu:              sync.RWMutex{},
		activeAccountId: 1,
		accounts: map[int]*AccountEntry{
			1: {
				ID:       1,
				Email:    "bob@example.com",
				PlanType: "free",
				Enabled:  true,
				// creditsKnown = false → no credits info
			},
		},
	}

	result := pool.GetActiveAccountInfo()
	if result == nil {
		t.Fatal("expected non-nil")
	}
	if result.Credits != nil {
		t.Error("expected nil credits when not known")
	}
	if result.PlanType != "free" {
		t.Errorf("expected free, got %s", result.PlanType)
	}
}

package main

import (
	"testing"
	"time"
)

// ═══════════════════════════════════════════════════════════════════════════
// ClearAccessToken
// ═══════════════════════════════════════════════════════════════════════════

func TestClearAccessToken_ClearsTokenAndExpiry(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID:                 1,
			Email:              "test@example.com",
			RefreshToken:       "fake-refresh",
			Enabled:            true,
			accessToken:        "old-token-12345",
			accessTokenExpiry:  time.Now().Add(30 * time.Minute),
			quotaStatus:        "ok",
		},
	)

	// Verify token exists before clear
	pool.mu.RLock()
	acc := pool.accounts[1]
	if acc.accessToken == "" {
		t.Fatal("precondition: expected non-empty access token")
	}
	pool.mu.RUnlock()

	// Clear it
	pool.ClearAccessToken(1)

	// Verify token is cleared
	pool.mu.RLock()
	if acc.accessToken != "" {
		t.Errorf("accessToken should be empty after clear, got %q", acc.accessToken)
	}
	if !acc.accessTokenExpiry.IsZero() {
		t.Errorf("accessTokenExpiry should be zero after clear, got %v", acc.accessTokenExpiry)
	}
	pool.mu.RUnlock()
}

func TestClearAccessToken_DoesNotAffectQuotaStatus(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID:                 1,
			Email:              "test@example.com",
			RefreshToken:       "fake-refresh",
			Enabled:            true,
			accessToken:        "some-token",
			accessTokenExpiry:  time.Now().Add(30 * time.Minute),
			quotaStatus:        "ok",
		},
	)

	pool.ClearAccessToken(1)

	// Quota status should remain "ok" — NOT exhausted
	pool.mu.RLock()
	acc := pool.accounts[1]
	if acc.quotaStatus != "ok" {
		t.Errorf("quotaStatus should remain 'ok' after ClearAccessToken, got %q", acc.quotaStatus)
	}
	if !acc.exhaustedUntil.IsZero() {
		t.Errorf("exhaustedUntil should be zero, got %v", acc.exhaustedUntil)
	}
	pool.mu.RUnlock()
}

func TestClearAccessToken_NonexistentAccountIsNoop(t *testing.T) {
	pool := makeTestPool()
	// Should not panic
	pool.ClearAccessToken(999)
}

// ═══════════════════════════════════════════════════════════════════════════
// 401 vs MarkExhausted: 验证 401 不会触发冷却
// ═══════════════════════════════════════════════════════════════════════════

func TestClearAccessToken_AccountStaysSelectable(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID:                 1,
			Email:              "acc1@example.com",
			RefreshToken:       "refresh1",
			Enabled:            true,
			accessToken:        "token-that-got-401",
			accessTokenExpiry:  time.Now().Add(30 * time.Minute),
			quotaStatus:        "ok",
		},
		&AccountEntry{
			ID:                 2,
			Email:              "acc2@example.com",
			RefreshToken:       "refresh2",
			Enabled:            true,
			quotaStatus:        "ok",
		},
	)

	// Simulate 401 handling: ClearAccessToken + MarkError (NOT MarkExhausted)
	pool.ClearAccessToken(1)
	pool.MarkError(1)

	// Account 1 should still be selectable (not exhausted)
	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("SelectAccount failed: %v", err)
	}

	// Either account could be selected — but #1 should NOT be excluded
	// Try selecting with #2 excluded to prove #1 is still available
	acc, err = pool.SelectAccount("gemini-2.5-pro", []int{2})
	if err != nil {
		t.Fatalf("SelectAccount with exclude=[2] failed: %v — account #1 was wrongly excluded", err)
	}
	if acc.ID != 1 {
		t.Errorf("expected account #1 to be selectable, got #%d", acc.ID)
	}
}

func TestMarkExhausted_AccountBecomesUnselectable(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID:           1,
			Email:        "acc1@example.com",
			RefreshToken: "refresh1",
			Enabled:      true,
			quotaStatus:  "ok",
		},
	)

	// MarkExhausted should make the account unselectable
	pool.MarkExhausted(1, "http_429_quota", "gemini-2.5-pro", 30)

	_, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err == nil {
		t.Error("expected SelectAccount to fail after MarkExhausted, but it succeeded")
	}
}

// Contrast test: proves that ClearAccessToken (401 path) does NOT
// behave like MarkExhausted (429 path)
func TestClearAccessToken_vs_MarkExhausted(t *testing.T) {
	// Pool with one account
	makePool := func() *AccountPool {
		return makeTestPool(
			&AccountEntry{
				ID:                1,
				Email:             "test@example.com",
				RefreshToken:      "refresh",
				Enabled:           true,
				accessToken:       "some-token",
				accessTokenExpiry: time.Now().Add(30 * time.Minute),
				quotaStatus:       "ok",
			},
		)
	}

	// 401 path: ClearAccessToken → account stays selectable
	pool401 := makePool()
	pool401.ClearAccessToken(1)
	pool401.MarkError(1)
	_, err401 := pool401.SelectAccount("gemini-2.5-pro", nil)
	if err401 != nil {
		t.Errorf("401 path: account should be selectable, got error: %v", err401)
	}

	// 429 path: MarkExhausted → account becomes unselectable
	pool429 := makePool()
	pool429.MarkExhausted(1, "http_429_quota", "gemini-2.5-pro", 30)
	_, err429 := pool429.SelectAccount("gemini-2.5-pro", nil)
	if err429 == nil {
		t.Error("429 path: account should NOT be selectable after MarkExhausted")
	}
}

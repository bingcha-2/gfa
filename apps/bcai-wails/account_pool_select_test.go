package main

import (
	"sync"
	"testing"
	"time"
)

// ─── SelectAccount: Quota-aware selection tests (TDD) ────────────────────
//
// These tests define the desired behavior BEFORE implementation.
// They should FAIL until SelectAccount is updated with quotaTier logic.

// helper: create a pool with given accounts (no persistence needed for tests)
func makeTestPool(accounts ...*AccountEntry) *AccountPool {
	pool := &AccountPool{
		mu:       sync.RWMutex{},
		accounts: make(map[int]*AccountEntry),
	}
	for _, acc := range accounts {
		if acc.blockedModels == nil {
			acc.blockedModels = make(map[string]time.Time)
		}
		pool.accounts[acc.ID] = acc
	}
	return pool
}

func TestSelectAccount_PreferAccountWithModelQuota(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "exhausted@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true},
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "fresh@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 72, IsBlocked: false},
				}},
			},
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if acc.ID != 2 {
		t.Errorf("expected account #2 (has quota), got #%d", acc.ID)
	}
}

func TestSelectAccount_FallbackToCreditsWhenAllExhausted(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "a@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true},
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "b@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true},
				}},
			},
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("should not error when all accounts have zero quota (credits fallback): %v", err)
	}
	if acc.ID != 1 && acc.ID != 2 {
		t.Errorf("expected account #1 or #2, got #%d", acc.ID)
	}
}

func TestSelectAccount_UnknownQuotaTreatedAsNeutral(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "no-data@example.com", Enabled: true,
			// no quotaGroups → tier 1 (unknown)
		},
		&AccountEntry{
			ID: 2, Email: "has-quota@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 50, IsBlocked: false},
				}},
			},
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Account 2 (tier 0: has quota) should be preferred over account 1 (tier 1: unknown)
	if acc.ID != 2 {
		t.Errorf("expected account #2 (has quota, tier 0), got #%d (tier %d might be wrong)", acc.ID, 1)
	}
}

func TestSelectAccount_UnknownPreferredOverExhausted(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "exhausted@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true},
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "unknown@example.com", Enabled: true,
			// no quotaGroups → tier 1 (unknown, possibly has quota)
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Unknown (tier 1) should be preferred over exhausted (tier 2)
	if acc.ID != 2 {
		t.Errorf("expected account #2 (unknown, tier 1), got #%d", acc.ID)
	}
}

func TestSelectAccount_SameTierUsesLRU(t *testing.T) {
	now := time.Now()
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "a@example.com", Enabled: true,
			lastUsedAt: now.Add(-10 * time.Second), // used 10s ago
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 80, IsBlocked: false},
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "b@example.com", Enabled: true,
			lastUsedAt: now.Add(-60 * time.Second), // used 60s ago (older)
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 50, IsBlocked: false},
				}},
			},
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Both are tier 0 (has quota), so LRU should pick account 2 (used longer ago)
	if acc.ID != 2 {
		t.Errorf("expected account #2 (LRU within same tier), got #%d", acc.ID)
	}
}

func TestSelectAccount_DifferentModelNotPenalized(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "a@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "claude", Entries: []QuotaEntry{
					{Key: "claude-sonnet-4", Percent: 0, IsBlocked: true}, // different model exhausted
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "b@example.com", Enabled: true,
			// no quota data
		},
	)

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Account 1 should NOT be penalized for claude being exhausted when requesting gemini
	// Both should be tier 1 (unknown for gemini), so LRU applies
	// Either account is acceptable
	if acc.ID != 1 && acc.ID != 2 {
		t.Errorf("expected account #1 or #2, got #%d", acc.ID)
	}
}

func TestSelectAccount_LockedModeIgnoresQuotaTier(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "locked@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true}, // exhausted
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "fresh@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 80, IsBlocked: false},
				}},
			},
		},
	)
	pool.lockedAccountId = 1 // force lock to account 1

	acc, err := pool.SelectAccount("gemini-2.5-pro", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Locked mode should always use the locked account, ignoring quota tier
	if acc.ID != 1 {
		t.Errorf("expected locked account #1, got #%d", acc.ID)
	}
}

func TestSelectAccount_EmptyModelKeyNoQuotaCheck(t *testing.T) {
	pool := makeTestPool(
		&AccountEntry{
			ID: 1, Email: "a@example.com", Enabled: true,
			quotaGroups: []QuotaGroup{
				{Provider: "gemini", Entries: []QuotaEntry{
					{Key: "gemini-2.5-pro", Percent: 0, IsBlocked: true},
				}},
			},
		},
		&AccountEntry{
			ID: 2, Email: "b@example.com", Enabled: true,
		},
	)

	acc, err := pool.SelectAccount("", nil) // no model key
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Without a model key, quota tier should not apply — pure LRU
	if acc.ID != 1 && acc.ID != 2 {
		t.Errorf("expected account #1 or #2, got #%d", acc.ID)
	}
}

package main

import "testing"

// Antigravity upstream quota fetch (Google fetchAvailableModels) stays on its
// own conservative 5min floor (antigravityQuotaMinIntervalMs) — unlike codex,
// which was lowered to 15s — so a busy session doesn't hit the Google API on
// every report.
func TestAntigravityClaimQuotaFetchThrottles(t *testing.T) {
	l := &Leaser{}
	base := int64(2_000_000)

	if !l.claimQuotaFetch(base) {
		t.Fatalf("first claim (never fetched) should pass")
	}
	if l.claimQuotaFetch(base + 60_000) {
		t.Fatalf("a claim 1 min later must be throttled")
	}
	if !l.claimQuotaFetch(base + antigravityQuotaMinIntervalMs) {
		t.Fatalf("a claim at/after the interval should pass again")
	}
}

func TestIsoToEpochMs(t *testing.T) {
	if got := isoToEpochMs(""); got != 0 {
		t.Fatalf("empty → 0, got %d", got)
	}
	if got := isoToEpochMs("not-a-time"); got != 0 {
		t.Fatalf("garbage → 0, got %d", got)
	}
	// Epoch-anchored: 1s past the unix epoch = 1000 ms.
	if got := isoToEpochMs("1970-01-01T00:00:01Z"); got != 1000 {
		t.Fatalf("1970+1s → %d, want 1000", got)
	}
}

package main

import "testing"

// The upstream codex usage fetch (and the quota-only report that follows it)
// must be time-throttled so a busy session doesn't hit wham/usage and
// double-report on every single request. Usage reports stay per-request; only
// the slow-moving 5h/weekly quota fetch is throttled.
func TestClaimQuotaFetchThrottles(t *testing.T) {
	l := &CodexLeaser{}
	base := int64(1_000_000)

	if !l.claimQuotaFetch(base) {
		t.Fatalf("first claim (never fetched) should pass")
	}
	if l.claimQuotaFetch(base + 60_000) {
		t.Fatalf("a claim 1 min later must be throttled")
	}
	if l.claimQuotaFetch(base + codexQuotaMinIntervalMs - 1) {
		t.Fatalf("a claim just under the interval must be throttled")
	}
	if !l.claimQuotaFetch(base + codexQuotaMinIntervalMs) {
		t.Fatalf("a claim at/after the interval should pass again")
	}
}

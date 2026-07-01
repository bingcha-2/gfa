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
	if l.claimQuotaFetch(base + 5_000) {
		t.Fatalf("a claim 5s later (under the 15s floor) must be throttled")
	}
	if l.claimQuotaFetch(base + codexQuotaMinIntervalMs - 1) {
		t.Fatalf("a claim just under the interval must be throttled")
	}
	if !l.claimQuotaFetch(base + codexQuotaMinIntervalMs) {
		t.Fatalf("a claim at/after the interval should pass again")
	}
}

// A transient upstream failure (network error / 5xx) must not burn the full
// 30s window: allowQuotaRetrySoon rolls the throttle back so the next report
// retries after only the short backoff — but still throttled within it, so a
// sustained outage can't hammer wham/usage on every report.
func TestAllowQuotaRetrySoon(t *testing.T) {
	l := &CodexLeaser{}
	base := int64(1_000_000)

	if !l.claimQuotaFetch(base) {
		t.Fatalf("first claim should pass")
	}
	// Simulate a transient failure right after the claim.
	l.allowQuotaRetrySoon(base)

	if l.claimQuotaFetch(base + codexQuotaRetryBackoffMs - 1) {
		t.Fatalf("within the retry backoff, must still be throttled")
	}
	if !l.claimQuotaFetch(base + codexQuotaRetryBackoffMs) {
		t.Fatalf("after the retry backoff, must be allowed again (no full 30s wait)")
	}
}

// allowQuotaRetrySoon must only move the timestamp backward, never forward —
// it must not accidentally extend an existing throttle window.
func TestAllowQuotaRetrySoonNeverExtends(t *testing.T) {
	l := &CodexLeaser{}
	base := int64(1_000_000)
	if !l.claimQuotaFetch(base) {
		t.Fatalf("first claim should pass")
	}
	// A stale nowMs whose rollback target is later than the current stamp must be ignored.
	l.allowQuotaRetrySoon(base + 2*codexQuotaMinIntervalMs)
	if l.claimQuotaFetch(base + codexQuotaMinIntervalMs - 1) {
		t.Fatalf("throttle window must not be shortened past the real floor")
	}
}

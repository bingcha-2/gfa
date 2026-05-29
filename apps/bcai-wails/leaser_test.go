package main

import "testing"

func TestSyncFromServerDerivesModelLimitsFromTokenWindowLimit(t *testing.T) {
	l := &Leaser{}

	l.syncFromServer(map[string]interface{}{
		"tokenWindowLimit": float64(100_000),
		"tokenWindowMs":    float64(2 * 60 * 60 * 1000),
	})

	status := l.GetStatus()
	localQuota := status["localQuota"].(map[string]interface{})

	if got := localQuota["opusTokenLimit"]; got != int64(100_000) {
		t.Fatalf("opusTokenLimit = %v, want %d", got, int64(100_000))
	}
	if got := localQuota["geminiTokenLimit"]; got != int64(500_000) {
		t.Fatalf("geminiTokenLimit = %v, want %d", got, int64(500_000))
	}
}

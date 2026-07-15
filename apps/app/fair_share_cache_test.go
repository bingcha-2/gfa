package main

import (
	"testing"
	"time"
)

func clearBoundFractionsForTest() {
	resetBoundFractions()
}

func fairShareCacheSizeForTest() int {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	return len(boundFractions)
}

func fairShareCacheHasForTest(bucket string) bool {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	_, ok := boundFractions[bucket]
	return ok
}

func TestFairShareCacheOnlyTracksAntigravity(t *testing.T) {
	clearBoundFractionsForTest()
	resetAt := time.Now().Add(time.Hour).UnixMilli()
	recordMyBucketFraction("codex-gpt", 0, resetAt, 0.5)
	recordMyBucketFraction("anthropic-claude", 0, resetAt, 0.5)
	recordMyBucketFraction("antigravity-claude", 0.4, resetAt, 0.5)

	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	if _, ok := boundFractions["codex-gpt"]; ok {
		t.Fatal("Codex must not enter the legacy fair-share cache")
	}
	if _, ok := boundFractions["anthropic-claude"]; ok {
		t.Fatal("Anthropic must not enter the legacy fair-share cache")
	}
	if got := boundFractions["antigravity-claude"].MyFraction; got != 0.4 {
		t.Fatalf("Antigravity fair-share fraction = %v, want 0.4", got)
	}
}

func TestResetBoundFractionsClearsAntigravityCache(t *testing.T) {
	recordMyBucketFraction("antigravity-gemini", 0.4, time.Now().Add(time.Hour).UnixMilli(), 1)
	resetBoundFractions()
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	if len(boundFractions) != 0 {
		t.Fatalf("fair-share cache not cleared: %v", boundFractions)
	}
}

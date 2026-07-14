package main

import (
	"strings"
	"sync"
)

// Antigravity still uses the upstream/fair-share algorithm. Codex and
// Anthropic are enforced by the subscription's product-scoped dollar windows
// and must never be blocked by this legacy local cache.
type bucketQuota struct {
	HasMy            bool
	MyFraction       float64
	MyResetAt        int64
	HasMyWeekly      bool
	MyWeeklyFraction float64
	MyWeeklyResetAt  int64
}

var (
	boundFracMu    sync.RWMutex
	boundFractions = map[string]bucketQuota{}
)

func isAntigravityBucket(bucket string) bool {
	return strings.HasPrefix(bucket, "antigravity-")
}

func recordMyBucketFraction(bucket string, fraction float64, resetAt int64, _ float64) {
	if !isAntigravityBucket(bucket) {
		return
	}
	boundFracMu.Lock()
	q := boundFractions[bucket]
	q.HasMy = true
	q.MyFraction = fraction
	q.MyResetAt = resetAt
	boundFractions[bucket] = q
	boundFracMu.Unlock()
}

func recordMyWeeklyBucketFraction(bucket string, fraction float64, resetAt int64) {
	if !isAntigravityBucket(bucket) {
		return
	}
	boundFracMu.Lock()
	q := boundFractions[bucket]
	q.HasMyWeekly = true
	q.MyWeeklyFraction = fraction
	q.MyWeeklyResetAt = resetAt
	boundFractions[bucket] = q
	boundFracMu.Unlock()
}

func clearMyBucketFraction(bucket string) {
	boundFracMu.Lock()
	defer boundFracMu.Unlock()
	q := boundFractions[bucket]
	q.HasMy = false
	q.MyFraction = 0
	q.MyResetAt = 0
	boundFractions[bucket] = q
}

func clearMyWeeklyBucketFraction(bucket string) {
	boundFracMu.Lock()
	defer boundFracMu.Unlock()
	q := boundFractions[bucket]
	q.HasMyWeekly = false
	q.MyWeeklyFraction = 0
	q.MyWeeklyResetAt = 0
	boundFractions[bucket] = q
}

func resetBoundFractions() {
	boundFracMu.Lock()
	boundFractions = map[string]bucketQuota{}
	boundFracMu.Unlock()
}

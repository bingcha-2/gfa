package main

import (
	"sync"
	"time"
)

// quotaWindowStatus 把一个账号级「5h + 周」限额窗口(剩余百分比 + 重置时间)转成
// 前端血条用的分数(0~1)和剩余毫秒。codex 与 anthropic 订阅号共用同一形状。
func quotaWindowStatus(hourlyPercent, weeklyPercent float64, hourlyResetISO, weeklyResetISO string, nowMs int64) map[string]interface{} {
	remMs := func(iso string) int64 {
		if iso == "" {
			return 0
		}
		t, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			return 0
		}
		if r := t.UnixMilli() - nowMs; r > 0 {
			return r
		}
		return 0
	}
	return map[string]interface{}{
		"hourlyFraction": hourlyPercent / 100,
		"weeklyFraction": weeklyPercent / 100,
		"hourlyResetMs":  remMs(hourlyResetISO),
		"weeklyResetMs":  remMs(weeklyResetISO),
	}
}

// codexQuotaStatus / claudeQuotaStatus:各自的账号级 5h/周 窗口 → 前端血条。
// nil 窗口返回 nil(前端退回单条 bucket 血条)。
func codexQuotaStatus(w *CodexQuotaWindow, nowMs int64) map[string]interface{} {
	if w == nil {
		return nil
	}
	return quotaWindowStatus(w.HourlyPercent, w.WeeklyPercent, w.HourlyResetTime, w.WeeklyResetTime, nowMs)
}

func claudeQuotaStatus(w *ClaudeQuotaWindow, nowMs int64) map[string]interface{} {
	if w == nil {
		return nil
	}
	return quotaWindowStatus(w.HourlyPercent, w.WeeklyPercent, w.HourlyResetTime, w.WeeklyResetTime, nowMs)
}

// 跨 leaser 共享的"绑定号上游剩余分数",按复合桶 `产品-族` 归类
// (antigravity-gemini / antigravity-claude / codex-gpt / anthropic-claude)。
// 前端血条优先用它,反映绑定号的真实余量(而非恒为"充足"的本地 used/limit)。
// 桶 key 与服务端一致(见 product_bucket.go 的 bucketKey)。
type bucketQuota struct {
	Fraction float64 // 剩余分数 0~1;-1 = 已查询但无额度信息(未知);未记录 = 还没数据
	ResetAt  int64   // 该 bucket 额度下次刷新的 epoch ms(0=未知)
}

var (
	boundFracMu    sync.RWMutex
	boundFractions = map[string]bucketQuota{}
)

// recordBoundFractionForModel 记录绑定号在该(产品,模型)上的上游剩余分数(0~1,
// -1=未知)及额度下次刷新时间(resetAt epoch ms,0=未知)。product 由调用方按自身
// 产品身份传入(antigravity / codex / anthropic),拼成复合桶 key。
func recordBoundFractionForModel(product, modelKey string, fraction float64, resetAt int64) {
	if modelKey == "" {
		return
	}
	bucket := bucketKey(product, modelKey)
	boundFracMu.Lock()
	boundFractions[bucket] = bucketQuota{Fraction: fraction, ResetAt: resetAt}
	boundFracMu.Unlock()
}

// recordBoundFractionForBucket 直接按复合桶 key 记录额度,用于服务端一次性带回的
// accountBuckets/fairShareQuota(其 key 已是 `产品-族`,直接透传)。
func recordBoundFractionForBucket(bucket string, fraction float64, resetAt int64) {
	if bucket == "" {
		return
	}
	boundFracMu.Lock()
	boundFractions[bucket] = bucketQuota{Fraction: fraction, ResetAt: resetAt}
	boundFracMu.Unlock()
}

// snapshotBoundFractions 返回各 bucket 当前剩余分数的拷贝。
func snapshotBoundFractions() map[string]float64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]float64, len(boundFractions))
	for k, v := range boundFractions {
		out[k] = v.Fraction
	}
	return out
}

// snapshotBoundResets 返回各 bucket 额度恢复的剩余毫秒(供每条血条各自显示倒计时)。
func snapshotBoundResets(nowMs int64) map[string]int64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]int64, len(boundFractions))
	for k, v := range boundFractions {
		if v.ResetAt > 0 {
			if rem := v.ResetAt - nowMs; rem > 0 {
				out[k] = rem
			} else {
				out[k] = 0
			}
		}
	}
	return out
}

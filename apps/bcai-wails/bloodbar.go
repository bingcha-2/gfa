package main

import (
	"sync"
	"time"
)

// codexQuotaStatus 把 codex 的 5h/周限额(剩余百分比 + 重置时间)转成前端血条用的
// 分数(0~1)和剩余毫秒。nil 窗口返回 nil(前端退回单条 Codex 血条)。
func codexQuotaStatus(w *CodexQuotaWindow, nowMs int64) map[string]interface{} {
	if w == nil {
		return nil
	}
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
		"hourlyFraction": w.HourlyPercent / 100,
		"weeklyFraction": w.WeeklyPercent / 100,
		"hourlyResetMs":  remMs(w.HourlyResetTime),
		"weeklyResetMs":  remMs(w.WeeklyResetTime),
	}
}

// 跨 leaser 共享的"绑定号上游剩余分数",按 bucket(gemini/codex/opus)归类。
// antigravity leaser 写 gemini/opus,codex leaser 写 codex。前端血条优先用它,
// 反映绑定号的真实余量(而非恒为"充足"的本地 used/limit)。
type bucketQuota struct {
	Fraction float64 // 剩余分数 0~1;-1 = 已查询但无额度信息(未知);未记录 = 还没数据
	ResetAt  int64   // 该 bucket 额度下次刷新的 epoch ms(0=未知)
}

var (
	boundFracMu    sync.RWMutex
	boundFractions = map[string]bucketQuota{}
)

// bucketForModel 把模型名归类到计费/显示 bucket,与服务端一致。空名返回空。
func bucketForModel(modelKey string) string {
	if modelKey == "" {
		return ""
	}
	if isGeminiModel(modelKey) {
		return "gemini"
	}
	if isCodexModel(modelKey) {
		return "codex"
	}
	return "opus"
}

// recordBoundFractionForModel 记录绑定号在该模型上的上游剩余分数(0~1,-1=未知)
// 及额度下次刷新时间(resetAt epoch ms,0=未知)。
func recordBoundFractionForModel(modelKey string, fraction float64, resetAt int64) {
	bucket := bucketForModel(modelKey)
	if bucket == "" {
		return
	}
	boundFracMu.Lock()
	boundFractions[bucket] = bucketQuota{Fraction: fraction, ResetAt: resetAt}
	boundFracMu.Unlock()
}

// recordBoundFractionForBucket 直接按 bucket(gemini/codex/opus)记录额度,
// 用于服务端一次性带回的 accountBuckets(激活时填满所有血条)。
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

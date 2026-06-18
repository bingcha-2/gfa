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
	// 负百分比 = 该窗口未知(限流头本次缺失)→ 分数 -1,前端按既有 "-1=未知" 约定
	// 退回/显示未知,而非画成一条负血条。
	frac := func(pct float64) float64 {
		if pct < 0 {
			return -1
		}
		return pct / 100
	}
	return map[string]interface{}{
		"hourlyFraction": frac(hourlyPercent),
		"weeklyFraction": frac(weeklyPercent),
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
	// 整号维度:这个号在上游还剩多少。所有共享它的卡看到的是同一个值。
	HasAccount      bool
	AccountFraction float64 // 0~1;-1 = 已查询但无额度信息(未知)
	AccountResetAt  int64   // 整号额度下次刷新的 epoch ms(0=未知)
	// 我的份额维度(5h 窗口):这张卡分到的 fair-share 份额还剩多少(仅绑定卡多租户时有)。
	HasMy      bool
	MyFraction float64
	MyResetAt  int64
	// MyShare = e_i:我的份额占整号的比例(0~1,独享=1)。供双层血条画「整号里我那一段」外层几何。
	MyShare float64
	// 我的份额维度(周窗口):同上,但对应 5h 之外的「周」公平份额(仅 codex/anthropic 下发)。
	HasMyWeekly      bool
	MyWeeklyFraction float64
	MyWeeklyResetAt  int64
}

var (
	boundFracMu    sync.RWMutex
	boundFractions = map[string]bucketQuota{}
)

// recordBoundFractionForModel 记录绑定号在该(产品,模型)上的【整号】上游剩余分数
// (0~1,-1=未知)及额度下次刷新时间。product 由调用方按自身产品身份传入
// (antigravity / codex / anthropic),拼成复合桶 key。
func recordBoundFractionForModel(product, modelKey string, fraction float64, resetAt int64) {
	if modelKey == "" {
		return
	}
	recordAccountBucketFraction(bucketKey(product, modelKey), fraction, resetAt)
}

// recordAccountBucketFraction 按复合桶 key 记录【整号】上游剩余分数,保留已有的"我的份额"。
// 用于 lease 响应里的 boundAccount.fraction 与 accountBuckets(整号视角)。
func recordAccountBucketFraction(bucket string, fraction float64, resetAt int64) {
	if bucket == "" {
		return
	}
	boundFracMu.Lock()
	q := boundFractions[bucket]
	q.HasAccount = true
	q.AccountFraction = fraction
	q.AccountResetAt = resetAt
	boundFractions[bucket] = q
	boundFracMu.Unlock()
}

// recordMyBucketFraction 按复合桶 key 记录【我的份额】(fair-share)剩余分数 + share(e_i),
// 保留已有的整号值。用于 lease 响应里的 fairShareQuota(这张卡分到的份额视角)。
func recordMyBucketFraction(bucket string, fraction float64, resetAt int64, share float64) {
	if bucket == "" {
		return
	}
	boundFracMu.Lock()
	q := boundFractions[bucket]
	q.HasMy = true
	q.MyFraction = fraction
	q.MyResetAt = resetAt
	q.MyShare = share
	boundFractions[bucket] = q
	boundFracMu.Unlock()
}

// recordMyWeeklyBucketFraction 按复合桶 key 记录【我的份额·周】(fair-share 周窗口)剩余分数,
// 保留已有的整号值与 5h 份额值。用于 lease 响应里的 weeklyFairShareQuota(周血条视角)。
func recordMyWeeklyBucketFraction(bucket string, fraction float64, resetAt int64) {
	if bucket == "" {
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

// resetBoundFractions 换卡时清空所有血条额度(整号 + 份额两维度一起清),避免旧卡残量
// (及其 resetAt 倒计时)串到新卡。新卡额度由下一次 lease/quota 应答按 bucket 重新写入。
func resetBoundFractions() {
	boundFracMu.Lock()
	boundFractions = map[string]bucketQuota{}
	boundFracMu.Unlock()
	Log("[bloodbar] Bound fractions reset (card changed)")
}

// snapshotAccountFractions 返回各 bucket 的【整号】剩余分数拷贝(仅含已记录整号的桶)。
func snapshotAccountFractions() map[string]float64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]float64)
	for k, v := range boundFractions {
		if v.HasAccount {
			out[k] = v.AccountFraction
		}
	}
	return out
}

// snapshotMyFractions 返回各 bucket 的【我的份额】剩余分数拷贝(仅含有 fair-share 的桶)。
func snapshotMyFractions() map[string]float64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]float64)
	for k, v := range boundFractions {
		if v.HasMy {
			out[k] = v.MyFraction
		}
	}
	return out
}

// snapshotAccountResets 返回各 bucket【整号】额度恢复的剩余毫秒(供号余量条显示倒计时)。
func snapshotAccountResets(nowMs int64) map[string]int64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]int64)
	for k, v := range boundFractions {
		if v.HasAccount && v.AccountResetAt > 0 {
			if rem := v.AccountResetAt - nowMs; rem > 0 {
				out[k] = rem
			} else {
				out[k] = 0
			}
		}
	}
	return out
}

// snapshotMyShares 返回各 bucket【我的份额占整号比例 e_i】拷贝(仅含有 fair-share 的桶),供双层血条外层几何。
func snapshotMyShares() map[string]float64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]float64)
	for k, v := range boundFractions {
		if v.HasMy {
			out[k] = v.MyShare
		}
	}
	return out
}

// snapshotMyResets 返回各 bucket【我的份额】额度恢复的剩余毫秒(供我的卡条显示倒计时)。
func snapshotMyResets(nowMs int64) map[string]int64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]int64)
	for k, v := range boundFractions {
		if v.HasMy && v.MyResetAt > 0 {
			if rem := v.MyResetAt - nowMs; rem > 0 {
				out[k] = rem
			} else {
				out[k] = 0
			}
		}
	}
	return out
}

// snapshotMyWeeklyFractions 返回各 bucket【我的份额·周】剩余分数拷贝(仅含有周份额的桶)。
func snapshotMyWeeklyFractions() map[string]float64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]float64)
	for k, v := range boundFractions {
		if v.HasMyWeekly {
			out[k] = v.MyWeeklyFraction
		}
	}
	return out
}

// snapshotMyWeeklyResets 返回各 bucket【我的份额·周】额度恢复的剩余毫秒(供周血条显示倒计时)。
func snapshotMyWeeklyResets(nowMs int64) map[string]int64 {
	boundFracMu.RLock()
	defer boundFracMu.RUnlock()
	out := make(map[string]int64)
	for k, v := range boundFractions {
		if v.HasMyWeekly && v.MyWeeklyResetAt > 0 {
			if rem := v.MyWeeklyResetAt - nowMs; rem > 0 {
				out[k] = rem
			} else {
				out[k] = 0
			}
		}
	}
	return out
}

package main

import (
	"fmt"
	"time"
)

// quota_enforcement.go — 绑定卡「本地 fair-share 拦截」。
//
// 为什么需要:绑定卡会缓存 lease token 几十分钟才重新取号一次,而服务端的 fair-share
// 取号闸(checkFairShare)只在取号那一下跑。缓存窗口内客户端拿旧 token 直连上游,服务端
// 拦不到 → 严重超用。这里用每次上报响应回灌的份额血条(MyFraction / MyWeeklyFraction)
// 在本地当场拦截,补上这个 enforcement 缺口。
//
// 精度边界(诚实说清):MyFraction 是「快照级」更新的,不是逐 token——
//   - antigravity:fraction 随客户端每次请求上报的 Google 快照归并,近乎逐请求,拦得很紧;
//   - claude / codex:fraction 由服务端周期性拉取(秒~分钟级),本地拦滞后到「一个快照
//     周期」,但远好于「一个取号窗口(几十分钟)」。
// 剩余在飞的逐请求级 margin 由服务端归并 + 账号 Σe≤1 兜底,账号永不烧爆。

// fairShareVerdict 仅凭缓存的份额血条判定该不该放行:5h 或周份额任一耗尽即拦,
// Retry-After 取对应窗口 reset 的倒计时。无份额数据(号池卡 / 尚未取过号)→ 放行。
func fairShareVerdict(q bucketQuota, nowMs int64) (ok bool, retryMs int64, reason string) {
	retryFor := func(resetAt int64) int64 {
		if resetAt <= 0 {
			return 0
		}
		if rem := resetAt - nowMs; rem > 0 {
			return rem
		}
		return 0
	}
	isActiveWindow := func(resetAt int64) bool {
		return resetAt > nowMs
	}
	if q.HasMy && q.MyFraction <= 0 && isActiveWindow(q.MyResetAt) {
		r := retryFor(q.MyResetAt)
		return false, r, fmt.Sprintf("公平限额已用完(5h),%d分钟后恢复", r/60000)
	}
	if q.HasMyWeekly && q.MyWeeklyFraction <= 0 && isActiveWindow(q.MyWeeklyResetAt) {
		r := retryFor(q.MyWeeklyResetAt)
		return false, r, fmt.Sprintf("本周公平限额已用完,%d分钟后恢复", r/60000)
	}
	return true, 0, ""
}

// checkBoundFairShare 按复合桶 key 读缓存的份额血条并判定。三家 proxy(antigravity 经
// CheckLocalQuota,claude/codex 经各自 ServeHTTP)共用此入口,口径一致。
func checkBoundFairShare(bucket string) (ok bool, retryMs int64, reason string) {
	boundFracMu.RLock()
	q := boundFractions[bucket]
	boundFracMu.RUnlock()
	return fairShareVerdict(q, time.Now().UnixMilli())
}

package main

import (
	"testing"
	"time"
)

// fairShareVerdict 是绑定卡「本地 fair-share 拦截」的纯判定核心:仅看缓存的份额血条
// (MyFraction / MyWeeklyFraction)决定该不该当场 429。缓存 token 期间服务端取号闸
// (checkFairShare)不跑,这是补上的本地 enforcement。详见 CheckLocalQuota。

const minute = int64(60_000)

// 无 fair-share 数据(号池卡 / 尚未取过号)→ 放行,保持旧行为。
func TestFairShareVerdict_NoData_Allows(t *testing.T) {
	ok, retry, reason := fairShareVerdict(bucketQuota{}, 1_000_000)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("无份额数据应放行, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

// 5h 份额还有余量 → 放行。
func TestFairShareVerdict_HealthyFiveHour_Allows(t *testing.T) {
	q := bucketQuota{HasMy: true, MyFraction: 0.5, MyResetAt: 2_000_000}
	if ok, _, _ := fairShareVerdict(q, 1_000_000); !ok {
		t.Fatalf("5h 份额 0.5 应放行")
	}
}

// 5h 份额耗尽 → 本地拦,Retry-After = MyResetAt 倒计时。
func TestFairShareVerdict_ExhaustedFiveHour_BlocksWithRetry(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{HasMy: true, MyFraction: 0, MyResetAt: now + 30*minute}
	ok, retry, reason := fairShareVerdict(q, now)
	if ok {
		t.Fatal("5h 份额耗尽应本地拦")
	}
	if retry != 30*minute {
		t.Fatalf("Retry-After 应为 30min 倒计时, got %d", retry)
	}
	if reason == "" {
		t.Fatal("拦截应带原因文案")
	}
}

// 周份额耗尽(5h 仍健康)→ 周窗口拦。
func TestFairShareVerdict_ExhaustedWeekly_Blocks(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{
		HasMy: true, MyFraction: 0.8, MyResetAt: now + 10*minute,
		HasMyWeekly: true, MyWeeklyFraction: 0, MyWeeklyResetAt: now + 5*24*60*minute,
	}
	ok, retry, _ := fairShareVerdict(q, now)
	if ok {
		t.Fatal("周份额耗尽应拦,即便 5h 还有余量")
	}
	if retry != 5*24*60*minute {
		t.Fatalf("周拦 Retry-After 应为周 reset 倒计时, got %d", retry)
	}
}

// resetAt 已过期或未知(0)→ Retry-After 兜底为 0,不返回负数。
func TestFairShareVerdict_ExhaustedNoReset_RetryZero(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{HasMy: true, MyFraction: 0, MyResetAt: now - 5*minute}
	_, retry, _ := fairShareVerdict(q, now)
	if retry != 0 {
		t.Fatalf("过期 reset 的 Retry-After 应兜底为 0, got %d", retry)
	}
}

func TestFairShareVerdict_ExpiredFiveHourWindow_Allows(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{HasMy: true, MyFraction: 0, MyResetAt: now - 5*minute}
	ok, retry, reason := fairShareVerdict(q, now)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("expired 5h fair-share window should not keep blocking, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

func TestFairShareVerdict_ExpiredWeeklyWindow_Allows(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{
		HasMy: true, MyFraction: 0.6, MyResetAt: now + 5*minute,
		HasMyWeekly: true, MyWeeklyFraction: 0, MyWeeklyResetAt: now - 5*minute,
	}
	ok, retry, reason := fairShareVerdict(q, now)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("expired weekly fair-share window should not keep blocking, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

func TestFairShareVerdict_ResetBoundaryAtNow_Allows(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{HasMy: true, MyFraction: 0, MyResetAt: now}
	ok, retry, reason := fairShareVerdict(q, now)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("resetAt == now should be treated as an expired window, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

func TestFairShareVerdict_UnknownFiveHourReset_Allows(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{HasMy: true, MyFraction: 0, MyResetAt: 0}
	ok, retry, reason := fairShareVerdict(q, now)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("unknown 5h reset should not permanently block, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

func TestFairShareVerdict_UnknownWeeklyReset_Allows(t *testing.T) {
	now := int64(1_000_000)
	q := bucketQuota{
		HasMy: true, MyFraction: 0.6, MyResetAt: now + 5*minute,
		HasMyWeekly: true, MyWeeklyFraction: 0, MyWeeklyResetAt: 0,
	}
	ok, retry, reason := fairShareVerdict(q, now)
	if !ok || retry != 0 || reason != "" {
		t.Fatalf("unknown weekly reset should not permanently block, got ok=%v retry=%v reason=%q", ok, retry, reason)
	}
}

// ── CheckLocalQuota: dynamic 卡接上本地 enforcement ──

// dynamic 卡份额耗尽 → 不再无脑放行,本地当场拦(antigravity 路径,product=antigravity)。
func TestCheckLocalQuota_Dynamic_BlocksOnExhaustedFairShare(t *testing.T) {
	clearBoundFractionsForTest()
	l := &Leaser{quotaMode: "dynamic"}
	recordMyBucketFraction(bucketKey("antigravity", "claude-opus-4-6"), 0, time.Now().UnixMilli()+30*minute, 1)

	ok, waitMs, reason := l.CheckLocalQuota("claude-opus-4-6")
	if ok {
		t.Fatal("dynamic 卡份额耗尽应本地拦,而非放行")
	}
	if waitMs <= 0 || reason == "" {
		t.Fatalf("拦截应带 Retry-After 与原因, got waitMs=%d reason=%q", waitMs, reason)
	}
}

// dynamic 卡份额健康 → 放行。
func TestCheckLocalQuota_Dynamic_AllowsWhenHealthy(t *testing.T) {
	clearBoundFractionsForTest()
	l := &Leaser{quotaMode: "dynamic"}
	recordMyBucketFraction(bucketKey("antigravity", "gemini-2.5-pro"), 0.5, 0, 1)

	if ok, _, _ := l.CheckLocalQuota("gemini-2.5-pro"); !ok {
		t.Fatal("dynamic 卡份额 0.5 应放行")
	}
}

// dynamic 卡无份额数据(号池卡 / 尚未取号)→ 放行,保持旧行为不误伤。
func TestCheckLocalQuota_Dynamic_AllowsWhenNoFairShareData(t *testing.T) {
	clearBoundFractionsForTest()
	l := &Leaser{quotaMode: "dynamic"}

	if ok, _, _ := l.CheckLocalQuota("gemini-2.5-pro"); !ok {
		t.Fatal("无份额数据应放行(否则号池卡/冷启动会被误拦)")
	}
}

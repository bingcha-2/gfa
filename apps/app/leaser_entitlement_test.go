package main

import (
	"errors"
	"sort"
	"sync/atomic"
	"testing"
	"time"
)

// 冷启动盲租 antigravity 的核心决策:接管启动时,是否该发起 antigravity 常驻租号。
// 纯函数,覆盖「心跳已知授权」与「冷启动未知(回退老 lease-products 逻辑)」两套输入。
func TestDecideAntigravity(t *testing.T) {
	cases := []struct {
		name          string
		entKnown      bool
		entitled      []string
		subActive     bool
		leaseProducts []string
		want          antigravityPlan
	}{
		// ── 心跳已喂入授权 ───────────────────────────────────────────────
		{"已知·有生效订阅·含 antigravity → 尝试", true, []string{"antigravity", "codex"}, true, nil, agAttempt},
		{"已知·有生效订阅·只 codex → 跳过(不判死)", true, []string{"codex"}, true, nil, agSkip},
		{"已知·有生效订阅·只 anthropic → 跳过", true, []string{"anthropic"}, true, nil, agSkip},
		{"已知·无生效订阅 → 卡密不可用", true, []string{}, false, nil, agNoSub},
		{"已知·无生效订阅(忽略残留 products)→ 卡密不可用", true, []string{"antigravity"}, false, nil, agNoSub},
		// ── 冷启动尚无心跳 → 回退老逻辑(按上次 lease 响应 products,空=池子=尝试)──
		{"未知·lease products 空 → 尝试(老逻辑)", false, nil, false, nil, agAttempt},
		{"未知·lease products 含 antigravity → 尝试", false, nil, false, []string{"antigravity"}, agAttempt},
		{"未知·lease products 只 codex → 跳过", false, nil, false, []string{"codex"}, agSkip},
	}
	for _, c := range cases {
		if got := decideAntigravity(c.entKnown, c.entitled, c.subActive, c.leaseProducts); got != c.want {
			t.Fatalf("%s: decideAntigravity=%v, want %v", c.name, got, c.want)
		}
	}
}

// 从 /app/heartbeat 响应解析「产品授权并集」+「是否有生效订阅」。
// 心跳 body 形如 { subscriptions: [{products:[...]}, ...] }(见服务端 buildSubscriptionSummary)。
func TestParseHeartbeatEntitlements(t *testing.T) {
	// 多条生效订阅 → products 并集去重,active=true,ok=true
	r1 := map[string]interface{}{
		"subscriptions": []interface{}{
			map[string]interface{}{"products": []interface{}{"codex", "anthropic"}},
			map[string]interface{}{"products": []interface{}{"codex", "antigravity"}},
		},
	}
	prods, active, ok := parseHeartbeatEntitlements(r1)
	if !ok || !active {
		t.Fatalf("有生效订阅应 ok=active=true,得 ok=%v active=%v", ok, active)
	}
	if !sameStringSet(prods, []string{"anthropic", "antigravity", "codex"}) {
		t.Fatalf("products 应为并集去重,得 %v", prods)
	}

	// 空订阅数组(服务端给了字段但无生效订阅)→ active=false, ok=true
	r2 := map[string]interface{}{"subscriptions": []interface{}{}}
	_, active2, ok2 := parseHeartbeatEntitlements(r2)
	if !ok2 || active2 {
		t.Fatalf("空订阅应 ok=true active=false,得 ok=%v active=%v", ok2, active2)
	}

	// 缺 subscriptions 字段(老服务端)→ ok=false:授权未知,调用方不应据此 seed
	r3 := map[string]interface{}{"ok": true}
	if _, _, ok3 := parseHeartbeatEntitlements(r3); ok3 {
		t.Fatalf("缺 subscriptions 字段应 ok=false")
	}
}

// 冷启动复现:lease 响应还没回来(accessKeyStatus 空),但心跳已喂入授权=只 codex。
// 必须按授权跳过 antigravity —— 不发一次 antigravity 租号、不把整卡判死(codex 仍可用)。
// 这正是老 bug 的场景:旧代码冷启动 products 空 → 当池子卡 → 盲租 antigravity → 被拒判死。
func TestStartAutoLeaseSkipsAntigravityWhenEntitledExcludesIt(t *testing.T) {
	var calls int32
	l := &Leaser{
		leaseFn: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
			atomic.AddInt32(&calls, 1)
			return nil, errors.New(" - SUBSCRIPTION_EXPIRED")
		},
	}
	l.SetEntitlements([]string{"codex"}, true)

	l.StartAutoLease("session-jwt", "dev-1", "")
	time.Sleep(50 * time.Millisecond) // 给可能误启动的 worker 一点时间暴露问题

	if n := atomic.LoadInt32(&calls); n != 0 {
		t.Fatalf("只开 codex 的有效订阅不该盲租 antigravity,实际调用 %d 次", n)
	}
	st := l.GetStatus()
	if st["cardUnusable"] != false {
		t.Fatalf("有效订阅(codex)不该被误判卡密不可用: cardUnusable=%v", st["cardUnusable"])
	}
	if st["autoLeaseRunning"] != false {
		t.Fatalf("未开 antigravity 不该启动其 worker: autoLeaseRunning=%v", st["autoLeaseRunning"])
	}
}

// 接管时走 agSkip(有生效订阅、只是没开 antigravity)要清掉之前可能的误判 cardUnusable ——
// 这让「冷启动盲租 antigravity 误判 → 心跳/刷新重新接管」能真正恢复,放行 codex/anthropic。
func TestStartAutoLeaseSkipClearsStaleCardUnusable(t *testing.T) {
	var calls int32
	l := &Leaser{
		cardUnusable: true, // 模拟冷启动盲租 antigravity 被误判
		leaseFn: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
			atomic.AddInt32(&calls, 1)
			return nil, errors.New(" - SUBSCRIPTION_EXPIRED")
		},
	}
	l.SetEntitlements([]string{"codex"}, true)

	l.StartAutoLease("session-jwt", "dev-1", "")
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("不该盲租 antigravity,实际 %d 次", calls)
	}
	if st := l.GetStatus(); st["cardUnusable"] != false {
		t.Fatalf("agSkip 应清掉误判的 cardUnusable,得 %v", st["cardUnusable"])
	}
}

// 心跳报告无生效订阅(取消/过期)→ 直接判卡密不可用,且不发任何 antigravity 租号。
func TestStartAutoLeaseMarksUnusableWhenNoActiveSub(t *testing.T) {
	var calls int32
	l := &Leaser{
		leaseFn: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
			atomic.AddInt32(&calls, 1)
			return nil, errors.New(" - SUBSCRIPTION_EXPIRED")
		},
	}
	l.SetEntitlements(nil, false)

	l.StartAutoLease("session-jwt", "dev-1", "")
	time.Sleep(50 * time.Millisecond)

	if n := atomic.LoadInt32(&calls); n != 0 {
		t.Fatalf("无生效订阅不该尝试租号,实际调用 %d 次", n)
	}
	if st := l.GetStatus(); st["cardUnusable"] != true {
		t.Fatalf("无生效订阅应判卡密不可用: cardUnusable=%v", st["cardUnusable"])
	}
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	ca := append([]string(nil), a...)
	cb := append([]string(nil), b...)
	sort.Strings(ca)
	sort.Strings(cb)
	for i := range ca {
		if ca[i] != cb[i] {
			return false
		}
	}
	return true
}

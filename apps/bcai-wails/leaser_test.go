package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

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

// anthropic-only(或 codex-only)绑定卡:主 antigravity 租号被有意跳过,cachedToken
// 永远为 nil —— serviceState 不应卡死在 waiting_first_lease(UI 永远「获取租约中…」)。
func TestServiceStateReadyForNonAntigravityBoundCard(t *testing.T) {
	l := &Leaser{
		accessKeyStatus: map[string]interface{}{
			"products": []interface{}{"anthropic"},
		},
	}
	if got := l.GetStatus()["serviceState"]; got != "ready" {
		t.Fatalf("anthropic-only 卡 serviceState = %v, want ready", got)
	}
}

// 开通 antigravity 的卡,在拿到 token 前仍应 waiting_first_lease(原行为不变)。
func TestServiceStateWaitsForAntigravityCard(t *testing.T) {
	l := &Leaser{accessKeyStatus: map[string]interface{}{"products": []interface{}{"antigravity"}}}
	if got := l.GetStatus()["serviceState"]; got != "waiting_first_lease" {
		t.Fatalf("antigravity 卡无 token serviceState = %v, want waiting_first_lease", got)
	}
}

// 池子卡(products 空 = 不限产品,覆盖 antigravity),无 token 时仍 waiting_first_lease。
func TestServiceStateWaitsForPoolCard(t *testing.T) {
	l := &Leaser{accessKeyStatus: map[string]interface{}{}}
	if got := l.GetStatus()["serviceState"]; got != "waiting_first_lease" {
		t.Fatalf("池子卡无 token serviceState = %v, want waiting_first_lease", got)
	}
}

func TestIsCardFatalError(t *testing.T) {
	// 卡本身不可用 → 致命,应停掉自动租号。
	fatal := []string{
		"Invalid access key",
		"Missing access key",
		"Access key expired",
		"Access key disabled",
		"账号卡未激活 (Account card not activated)",
	}
	for _, m := range fatal {
		if !isCardFatalError(m) {
			t.Fatalf("应判为致命(卡不可用): %q", m)
		}
	}
	// 暂时性 / 与卡有效性无关 → 不应致命(继续重试)。
	nonFatal := []string{
		"当前账号繁忙，额度恢复中，请稍后重试",
		"No account with projectId is available.",
		"此卡未开通该服务，请联系客服", // 卡有效,只是没开这个池
		"network error",
		"",
	}
	for _, m := range nonFatal {
		if isCardFatalError(m) {
			t.Fatalf("不应判为致命: %q", m)
		}
	}
}

func TestMarkCardUnusableStopsAutoLease(t *testing.T) {
	l := &Leaser{leaseRunning: true}
	l.markCardUnusable(errors.New("Invalid access key"))

	if !l.cardUnusable {
		t.Fatal("cardUnusable 应为 true")
	}
	if l.leaseRunning {
		t.Fatal("致命卡错误后应停掉自动租号(leaseRunning=false)")
	}
	if st := l.GetStatus(); st["cardUnusable"] != true {
		t.Fatalf("GetStatus 应上报 cardUnusable=true, 得到 %v", st["cardUnusable"])
	}
}

func TestLeaseTokenSuccessClearsCardUnusable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":                   true,
			"accessToken":          "token-ok",
			"projectId":            "project-ok",
			"accountId":            8,
			"leaseId":              "lease-ok",
			"accessTokenExpiresIn": 3600,
			"activationExpiresAt":  "2027-01-01T00:00:00Z",
			"candidateStats":       map[string]interface{}{"healthyForModel": 1},
			"accessKeyStatus":      map[string]interface{}{"products": []interface{}{"antigravity"}},
			"accountBuckets":       map[string]interface{}{},
		})
	}))
	defer srv.Close()
	oldBase := API_BASE
	API_BASE = srv.URL
	t.Cleanup(func() { API_BASE = oldBase })

	l := &Leaser{cardUnusable: true, lastError: "Invalid access key"}
	if _, err := l.LeaseToken("card-1", "dev-1", true, nil, ""); err != nil {
		t.Fatalf("LeaseToken should succeed: %v", err)
	}

	st := l.GetStatus()
	if st["cardUnusable"] != false {
		t.Fatalf("successful lease should clear cardUnusable, got %v", st["cardUnusable"])
	}
	if st["lastError"] != "" {
		t.Fatalf("successful lease should clear lastError, got %q", st["lastError"])
	}
}

func TestActivateSuccessClearsCardUnusable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"data": map[string]interface{}{
				"accountCard": map[string]interface{}{"expiresAt": "2027-01-01T00:00:00Z"},
				"accessKeyStatus": map[string]interface{}{
					"products": []interface{}{"anthropic"},
				},
			},
		})
	}))
	defer srv.Close()
	oldBase := API_BASE
	API_BASE = srv.URL
	t.Cleanup(func() { API_BASE = oldBase })

	l := &Leaser{cardUnusable: true, lastError: "Invalid access key"}
	if _, err := l.Activate("card-1", "dev-1", ""); err != nil {
		t.Fatalf("Activate should succeed: %v", err)
	}

	st := l.GetStatus()
	if st["cardUnusable"] != false {
		t.Fatalf("successful activation should clear cardUnusable, got %v", st["cardUnusable"])
	}
	if st["lastError"] != "" {
		t.Fatalf("successful activation should clear lastError, got %q", st["lastError"])
	}
}

// 整体逻辑核心:coversAntigravity 由卡的 products 决定。池子卡(空)/含 antigravity → 跑;
// 只绑 codex(或其它非 antigravity 产品) → 不跑。
func TestCoversAntigravity(t *testing.T) {
	cases := []struct {
		products []interface{}
		want     bool
		desc     string
	}{
		{nil, true, "池子卡(products 未知/空)→ 覆盖一切"},
		{[]interface{}{}, true, "池子卡(products 空数组)→ 覆盖一切"},
		{[]interface{}{"antigravity"}, true, "antigravity-only 卡"},
		{[]interface{}{"codex", "antigravity"}, true, "双开卡"},
		{[]interface{}{"codex"}, false, "codex-only 卡 → 不跑 antigravity"},
		{[]interface{}{"other"}, false, "只开其它产品 → 不跑 antigravity"},
	}
	for _, c := range cases {
		l := &Leaser{}
		if c.products != nil {
			l.accessKeyStatus = map[string]interface{}{"products": c.products}
		}
		if got := l.coversAntigravity(); got != c.want {
			t.Fatalf("%s: coversAntigravity()=%v, want %v", c.desc, got, c.want)
		}
	}
}

// codex-only 卡:StartAutoLease 直接按 products 跳过 antigravity 自动租号 ——
// 不启动 worker(leaseFn 一次都不调)、不刷错(lastError 空)、不禁用整卡。
func TestStartAutoLeaseSkipsAntigravityForCodexOnlyCard(t *testing.T) {
	var calls int32
	l := &Leaser{
		accessKeyStatus: map[string]interface{}{"products": []interface{}{"codex"}},
		leaseFn: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
			atomic.AddInt32(&calls, 1)
			return nil, errors.New("此卡未开通该服务，请联系客服")
		},
	}

	l.StartAutoLease("BCAI-CODEX-ONLY", "dev-1", "")

	// 给可能误启动的 goroutine 一点时间暴露问题。
	time.Sleep(50 * time.Millisecond)

	if n := atomic.LoadInt32(&calls); n != 0 {
		t.Fatalf("codex-only 卡不该发起任何 antigravity 租号,实际调用 %d 次", n)
	}
	st := l.GetStatus()
	if st["autoLeaseRunning"] != false {
		t.Fatalf("codex-only 卡不该启动 antigravity 自动租号 worker: autoLeaseRunning=%v", st["autoLeaseRunning"])
	}
	if st["cardUnusable"] != false {
		t.Fatalf("不该禁用整卡(codex 仍可用): cardUnusable=%v", st["cardUnusable"])
	}
	if st["lastError"] != "" {
		t.Fatalf("不该向前端报错: lastError=%q", st["lastError"])
	}
	if st["serviceState"] == "error" {
		t.Fatalf("不该进入 error 状态: serviceState=%v", st["serviceState"])
	}
}

// 池子卡 / antigravity 卡:StartAutoLease 正常跑 antigravity 自动租号(warmup 会调 leaseFn)。
func TestStartAutoLeaseRunsAntigravityForCoveredCard(t *testing.T) {
	for _, products := range [][]interface{}{nil, {"antigravity"}, {"codex", "antigravity"}} {
		var calls int32
		l := &Leaser{
			leaseFn: func(card, deviceId string, force bool, options map[string]interface{}, upstreamProxy string) (*TokenLease, error) {
				atomic.AddInt32(&calls, 1)
				// 返回一个 token(Bound=false)→ refreshBoundQuota 早退,不打真实网络。
				return &TokenLease{AccessToken: "t", ProjectId: "p", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}, nil
			},
		}
		if products != nil {
			l.accessKeyStatus = map[string]interface{}{"products": products}
		}

		l.StartAutoLease("BCAI-CARD", "dev-1", "")

		deadline := time.Now().Add(2 * time.Second)
		for atomic.LoadInt32(&calls) == 0 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if n := atomic.LoadInt32(&calls); n == 0 {
			t.Fatalf("products=%v 的卡应跑 antigravity warmup 租号,但 leaseFn 从未被调用", products)
		}
		if st := l.GetStatus(); st["autoLeaseRunning"] != true {
			t.Fatalf("products=%v 的卡应在运行 antigravity 自动租号", products)
		}
		l.StopAutoLease()
	}
}

func TestGetStatusExposesBoundAccountResetMs(t *testing.T) {
	l := &Leaser{}
	l.boundResetAt = time.Now().UnixMilli() + 3_600_000 // 绑定号上游 1h 后刷新
	v, ok := l.GetStatus()["boundResetMs"].(int64)
	if !ok || v <= 0 || v > 3_600_000 {
		t.Fatalf("boundResetMs 应反映绑定号上游重置剩余, got %v (ok=%v)", v, ok)
	}
}

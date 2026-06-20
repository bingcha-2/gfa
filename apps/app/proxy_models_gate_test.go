package main

import (
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

var errAssertLeaseAttempted = errors.New("lease attempted")

// fetchAvailableModels 探测路径(handleFetchModelsWithCache)曾无条件直接租号,绕过
// StartAutoLease 的 antigravity 授权门控:本卡有生效订阅但未开 antigravity 时,这次
// 探测租号会被服务端拒为 SUBSCRIPTION_EXPIRED,并在 LeaseToken 里把 lastError 写成
// SUBSCRIPTION_EXPIRED —— 把 StartAutoLease(agSkip)刚清空的状态重新投毒,顶部状态栏
// 闪「错误 · SUBSCRIPTION_EXPIRED」。与 codex/anthropic(未授权即静默跳过)不一致。
//
// 修复后:models 探测复用同一道 coversAntigravity() 门控,已知未开通就不发租号、直接
// 走缓存/兜底模型列表,不再污染 lastError。
func TestFetchModelsSkipsLeaseWhenAntigravityNotEntitled(t *testing.T) {
	prev := globalLeaser
	globalLeaser = &Leaser{}
	t.Cleanup(func() { globalLeaser = prev })

	var leaseCalls int32
	prevFn := modelsProbeLeaseFn
	modelsProbeLeaseFn = func(l *Leaser, card, deviceId, upstream string) (*TokenLease, error) {
		atomic.AddInt32(&leaseCalls, 1)
		return nil, nil
	}
	t.Cleanup(func() { modelsProbeLeaseFn = prevFn })

	// 有生效订阅、但只开了 codex(未授权 antigravity)—— 等价 StartAutoLease 的 agSkip。
	GetLeaser().SetEntitlements([]string{"codex"}, true)

	p := &ProxyServer{}
	body := []byte(`{}`)
	r := httptest.NewRequest("POST", "/v1internal:fetchAvailableModels", strings.NewReader(string(body)))
	w := httptest.NewRecorder()

	p.handleFetchModelsWithCache(w, r, body, "session-jwt", "dev-1", "", 1)

	if n := atomic.LoadInt32(&leaseCalls); n != 0 {
		t.Fatalf("未开通 antigravity 时 models 探测不该发租号,实际调用 %d 次", n)
	}
	if got := GetLeaser().LastError(); got != "" {
		t.Fatalf("未开通 antigravity 的 models 探测不该写 lastError,实际=%q", got)
	}
	if w.Code != 200 {
		t.Fatalf("应降级返回兜底模型列表(200),实际=%d", w.Code)
	}
	if respBody := w.Body.String(); !strings.Contains(respBody, "models") {
		t.Fatalf("响应应是模型列表兜底,实际=%q", respBody)
	}
}

// 冷启动尚未拿到心跳授权(entitlementsKnown=false)时,coversAntigravity()=true,models
// 探测仍照常发租号(沿用老逻辑先试一次),不被新门控误拦。
func TestFetchModelsStillLeasesOnColdStart(t *testing.T) {
	prev := globalLeaser
	globalLeaser = &Leaser{}
	t.Cleanup(func() { globalLeaser = prev })

	var leaseCalls int32
	prevFn := modelsProbeLeaseFn
	modelsProbeLeaseFn = func(l *Leaser, card, deviceId, upstream string) (*TokenLease, error) {
		atomic.AddInt32(&leaseCalls, 1)
		return nil, errAssertLeaseAttempted // 返回 err → 走兜底,不打网络/不解引用 nil lease
	}
	t.Cleanup(func() { modelsProbeLeaseFn = prevFn })

	// 不调用 SetEntitlements → entitlementsKnown=false(冷启动)。

	p := &ProxyServer{}
	body := []byte(`{}`)
	r := httptest.NewRequest("POST", "/v1internal:fetchAvailableModels", strings.NewReader(string(body)))
	w := httptest.NewRecorder()

	p.handleFetchModelsWithCache(w, r, body, "session-jwt", "dev-1", "", 1)

	if n := atomic.LoadInt32(&leaseCalls); n != 1 {
		t.Fatalf("冷启动应照常发一次租号探测,实际 %d 次", n)
	}
}

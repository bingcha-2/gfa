package main

import (
	"errors"
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

func TestGetStatusExposesBoundAccountResetMs(t *testing.T) {
	l := &Leaser{}
	l.boundResetAt = time.Now().UnixMilli() + 3_600_000 // 绑定号上游 1h 后刷新
	v, ok := l.GetStatus()["boundResetMs"].(int64)
	if !ok || v <= 0 || v > 3_600_000 {
		t.Fatalf("boundResetMs 应反映绑定号上游重置剩余, got %v (ok=%v)", v, ok)
	}
}

package hub

import (
	"sync/atomic"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/refreshcfg"
)

type fakeQuotaTarget struct {
	codex int32
	ag    int32
}

func (f *fakeQuotaTarget) RefreshAllQuotas(p account.Provider) (int, error) {
	switch p {
	case account.ProviderCodex:
		atomic.AddInt32(&f.codex, 1)
	case account.ProviderAntigravity:
		atomic.AddInt32(&f.ag, 1)
	}
	return 0, nil
}

func TestAutoRefresher_DueGate(t *testing.T) {
	ar := newAutoRefresher(&fakeQuotaTarget{}, refreshcfg.Config{QuotaMinutes: 10, CurrentMinutes: 1})
	now := int64(1_700_000_000_000)
	if !ar.dueAt(now) {
		t.Fatal("first run (lastRun=0) should be due")
	}
	ar.runOnce(now)
	if ar.dueAt(now + 9*60_000) {
		t.Fatal("within interval should NOT be due")
	}
	if !ar.dueAt(now + 10*60_000) {
		t.Fatal("at interval should be due")
	}
}

func TestAutoRefresher_RunOnceHitsBothProviders(t *testing.T) {
	f := &fakeQuotaTarget{}
	ar := newAutoRefresher(f, refreshcfg.Config{QuotaMinutes: 10, CurrentMinutes: 1})
	ar.runOnce(1)
	if atomic.LoadInt32(&f.codex) != 1 || atomic.LoadInt32(&f.ag) != 1 {
		t.Fatalf("expected both providers refreshed, codex=%d ag=%d", f.codex, f.ag)
	}
}

func TestAutoRefresher_ZeroIntervalNeverDue(t *testing.T) {
	ar := newAutoRefresher(&fakeQuotaTarget{}, refreshcfg.Config{QuotaMinutes: 0})
	if ar.dueAt(1_700_000_000_000) {
		t.Fatal("zero interval should never be due")
	}
}

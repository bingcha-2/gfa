package wakeup

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

func accts(emails ...string) AccountsFunc {
	return func() []*account.Account {
		out := make([]*account.Account, 0, len(emails))
		for i, e := range emails {
			out = append(out, &account.Account{ID: string(rune('a' + i)), Email: e})
		}
		return out
	}
}

func TestDueAt_DisabledIsNeverDue(t *testing.T) {
	s := New(nil, accts("x@y"))
	s.SetConfig(Config{Enabled: false, IntervalMinutes: 1})
	if s.DueAt(1_000_000_000_000) {
		t.Fatal("disabled should never be due")
	}
}

func TestDueAt_IntervalGate(t *testing.T) {
	s := New(func(ctx context.Context, a *account.Account) (int64, error) { return 0, nil }, accts("x@y"))
	s.SetConfig(Config{Enabled: true, IntervalMinutes: 60})
	now := int64(1_000_000_000_000)
	if !s.DueAt(now) {
		t.Fatal("first run (lastRun=0) should be due")
	}
	s.RunOnce(context.Background(), now)
	if s.DueAt(now + 59*60_000) {
		t.Fatal("within interval should NOT be due")
	}
	if !s.DueAt(now + 60*60_000) {
		t.Fatal("at/after interval should be due")
	}
}

func TestRunOnce_RecordsResultsAndHistory(t *testing.T) {
	failFor := map[string]bool{"b": true} // 第二个账号(ID="b")失败
	s := New(func(ctx context.Context, a *account.Account) (int64, error) {
		if failFor[a.ID] {
			return 0, errors.New("keepalive failed")
		}
		return 1_700_000_111, nil // 续约后新过期时刻
	}, accts("a@y", "b@y"))
	s.SetConfig(Config{Enabled: true, IntervalMinutes: 60})

	now := int64(1_700_000_000_000)
	entries := s.RunOnce(context.Background(), now)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if !entries[0].Ok || entries[0].NewExpiry != 1_700_000_111 {
		t.Fatalf("entry[0] should be ok with new expiry: %+v", entries[0])
	}
	if entries[1].Ok || entries[1].Err == "" {
		t.Fatalf("entry[1] should fail: %+v", entries[1])
	}
	hist := s.History()
	if len(hist) != 2 || hist[0].Email != "b@y" { // 新→旧,最新是 b
		t.Fatalf("history wrong: %+v", hist)
	}
}

func TestRunOnce_DefaultIntervalWhenZero(t *testing.T) {
	s := New(nil, accts())
	s.SetConfig(Config{Enabled: true, IntervalMinutes: 0})
	if s.GetConfig().IntervalMinutes != defaultIntervalMin {
		t.Fatalf("zero interval should default to %d, got %d", defaultIntervalMin, s.GetConfig().IntervalMinutes)
	}
}

func TestStart_FiresWhenDue(t *testing.T) {
	var calls int32
	s := New(func(ctx context.Context, a *account.Account) (int64, error) { atomic.AddInt32(&calls, 1); return 0, nil }, accts("x@y"))
	s.SetConfig(Config{Enabled: true, IntervalMinutes: 60}) // lastRun=0 → 立即 due
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx, 5*time.Millisecond)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&calls) >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if atomic.LoadInt32(&calls) < 1 {
		t.Fatal("Start should have fired at least one ping when due")
	}
}

func TestStart_DisabledDoesNotFire(t *testing.T) {
	var calls int32
	s := New(func(ctx context.Context, a *account.Account) (int64, error) { atomic.AddInt32(&calls, 1); return 0, nil }, accts("x@y"))
	s.SetConfig(Config{Enabled: false})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx, 5*time.Millisecond)
	time.Sleep(80 * time.Millisecond)
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("disabled scheduler should not fire, got %d", calls)
	}
}

func TestHistory_CapsAtMax(t *testing.T) {
	s := New(func(ctx context.Context, a *account.Account) (int64, error) { return 0, nil }, accts("only@y"))
	s.SetConfig(Config{Enabled: true})
	for i := 0; i < maxHistory+30; i++ {
		s.RunOnce(context.Background(), int64(i))
	}
	if got := len(s.History()); got != maxHistory {
		t.Fatalf("history should cap at %d, got %d", maxHistory, got)
	}
}

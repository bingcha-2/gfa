package wakeup

import (
	"context"
	"errors"
	"testing"

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
	s := New(func(ctx context.Context, id string) error { return nil }, accts("x@y"))
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
	failFor := map[string]bool{"b": true} // 第二个账号失败
	s := New(func(ctx context.Context, id string) error {
		if failFor[id] {
			return errors.New("ping failed")
		}
		return nil
	}, accts("a@y", "b@y"))
	s.SetConfig(Config{Enabled: true, IntervalMinutes: 60})

	now := int64(1_700_000_000_000)
	entries := s.RunOnce(context.Background(), now)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if !entries[0].Ok || entries[1].Ok || entries[1].Err == "" {
		t.Fatalf("entries wrong: %+v", entries)
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

func TestHistory_CapsAtMax(t *testing.T) {
	s := New(func(ctx context.Context, id string) error { return nil }, accts("only@y"))
	s.SetConfig(Config{Enabled: true})
	for i := 0; i < maxHistory+30; i++ {
		s.RunOnce(context.Background(), int64(i))
	}
	if got := len(s.History()); got != maxHistory {
		t.Fatalf("history should cap at %d, got %d", maxHistory, got)
	}
}

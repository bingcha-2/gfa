package wakeup

import "testing"

func TestConfigStore_DefaultWhenMissing(t *testing.T) {
	s := NewConfigStore(t.TempDir(), "codex")
	c := s.Load()
	if c.Enabled || c.IntervalMinutes != defaultIntervalMin {
		t.Fatalf("missing config should default: %+v", c)
	}
}

func TestConfigStore_SaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewConfigStore(dir, "codex")
	if err := s.Save(Config{Enabled: true, IntervalMinutes: 90}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	c := NewConfigStore(dir, "codex").Load() // 新实例从磁盘读
	if !c.Enabled || c.IntervalMinutes != 90 {
		t.Fatalf("round-trip wrong: %+v", c)
	}
	// 不同 provider 互不影响
	if NewConfigStore(dir, "antigravity").Load().Enabled {
		t.Fatal("other provider should be default disabled")
	}
}

func TestConfigStore_ZeroIntervalDefaults(t *testing.T) {
	dir := t.TempDir()
	_ = NewConfigStore(dir, "codex").Save(Config{Enabled: true, IntervalMinutes: 0})
	if got := NewConfigStore(dir, "codex").Load().IntervalMinutes; got != defaultIntervalMin {
		t.Fatalf("zero interval should default to %d, got %d", defaultIntervalMin, got)
	}
}

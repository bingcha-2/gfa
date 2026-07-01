package routingcfg

import "testing"

func TestStore_DefaultsToPriority(t *testing.T) {
	s := NewStore(t.TempDir())
	if got := s.Load(); got != StrategyPriority {
		t.Fatalf("default strategy = %q, want %q", got, StrategyPriority)
	}
}

func TestStore_SaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Save(StrategyRoundRobin); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := s.Load(); got != StrategyRoundRobin {
		t.Fatalf("after save Load = %q, want %q", got, StrategyRoundRobin)
	}
	// 新实例从磁盘读到同样的值(持久化生效)。
	if got := NewStore(dir).Load(); got != StrategyRoundRobin {
		t.Fatalf("reopened Load = %q, want %q", got, StrategyRoundRobin)
	}
}

func TestStore_RejectsUnknownStrategy(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Save("bogus"); err == nil {
		t.Fatal("expected error saving unknown strategy")
	}
	// 未知值不落盘,仍是默认。
	if got := s.Load(); got != StrategyPriority {
		t.Fatalf("Load after rejected save = %q, want %q", got, StrategyPriority)
	}
}

func TestStore_LoadCorruptFileFallsBackToDefault(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Save(StrategyFair); err != nil {
		t.Fatal(err)
	}
	// 损坏文件 → 回退默认,不 panic。
	if err := writeRaw(dir, "{not json"); err != nil {
		t.Fatal(err)
	}
	if got := NewStore(dir).Load(); got != StrategyPriority {
		t.Fatalf("corrupt Load = %q, want default %q", got, StrategyPriority)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]Strategy{
		"round-robin": StrategyRoundRobin,
		"roundrobin":  StrategyRoundRobin,
		"priority":    StrategyPriority,
		"fair":        StrategyFair,
		"":            StrategyPriority,
		"weird":       StrategyPriority,
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

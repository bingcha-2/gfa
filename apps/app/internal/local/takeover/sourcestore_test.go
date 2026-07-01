package takeover

import "testing"

func TestSourceStore_DefaultRemote(t *testing.T) {
	s := NewSourceStore(t.TempDir())
	if s.Get("codex") != SourceRemote {
		t.Fatal("unset product should default to remote")
	}
}

func TestSourceStore_SetGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceStore(dir)
	if err := s.Set("codex", SourceLocal); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if s.Get("codex") != SourceLocal {
		t.Fatal("expected local after set")
	}
	// 另一个产品不受影响,仍默认 remote
	if s.Get("antigravity") != SourceRemote {
		t.Fatal("other product should remain remote")
	}
	// 新实例从磁盘读取,持久化生效
	s2 := NewSourceStore(dir)
	if s2.Get("codex") != SourceLocal {
		t.Fatal("expected persisted local on reload")
	}
}

func TestSourceStore_Overwrite(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceStore(dir)
	_ = s.Set("codex", SourceLocal)
	_ = s.Set("codex", SourceRemote)
	if s.Get("codex") != SourceRemote {
		t.Fatal("expected remote after overwrite")
	}
}

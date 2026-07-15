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

func TestSourceStore_ProviderRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewSourceStore(dir)
	if err := s.SetProvider("codex", "prov-42"); err != nil {
		t.Fatalf("SetProvider: %v", err)
	}
	if s.Get("codex") != SourceProvider {
		t.Fatalf("expected provider source, got %q", s.Get("codex"))
	}
	if id := s.GetProviderID("codex"); id != "prov-42" {
		t.Fatalf("GetProviderID = %q, want prov-42", id)
	}
	// 持久化
	s2 := NewSourceStore(dir)
	if s2.Get("codex") != SourceProvider || s2.GetProviderID("codex") != "prov-42" {
		t.Fatalf("provider source/id not persisted: src=%q id=%q", s2.Get("codex"), s2.GetProviderID("codex"))
	}
	// 切回 local 后 provider id 不再返回
	_ = s.Set("codex", SourceLocal)
	if s.GetProviderID("codex") != "" {
		t.Fatal("provider id should be empty after switching to local")
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

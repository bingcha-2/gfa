package instance

import "testing"

func TestStore_CRUDAndProviderFilter(t *testing.T) {
	s := NewStore(t.TempDir())

	a := &Profile{Provider: "codex", Name: "工作", UserDataDir: "/tmp/a"}
	b := &Profile{Provider: "antigravity", Name: "备用", UserDataDir: "/tmp/b"}
	if err := s.Create(a); err != nil {
		t.Fatalf("Create a: %v", err)
	}
	if a.ID == "" || a.CreatedAt == 0 {
		t.Fatal("Create should assign id + createdAt")
	}
	_ = s.Create(b)

	codex, _ := s.List("codex")
	if len(codex) != 1 || codex[0].Name != "工作" {
		t.Fatalf("provider filter wrong: %+v", codex)
	}
	all, _ := s.List("")
	if len(all) != 2 {
		t.Fatalf("expected 2 total, got %d", len(all))
	}

	got, ok := s.Get(a.ID)
	if !ok || got.UserDataDir != "/tmp/a" {
		t.Fatalf("Get wrong: %+v ok=%v", got, ok)
	}

	a.BindAccountID = "acc-1"
	if err := s.Update(a); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got, _ = s.Get(a.ID)
	if got.BindAccountID != "acc-1" || got.CreatedAt == 0 {
		t.Fatalf("update lost fields: %+v", got)
	}

	if err := s.Delete(b.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	all, _ = s.List("")
	if len(all) != 1 || all[0].ID != a.ID {
		t.Fatalf("after delete wrong: %+v", all)
	}
}

func TestStore_SetPid(t *testing.T) {
	s := NewStore(t.TempDir())
	p := &Profile{Provider: "codex", Name: "x"}
	_ = s.Create(p)

	if err := s.SetPid(p.ID, 1234); err != nil {
		t.Fatalf("SetPid: %v", err)
	}
	got, _ := s.Get(p.ID)
	if got.Pid != 1234 || got.LastLaunchedAt == 0 {
		t.Fatalf("running state wrong: %+v", got)
	}
	_ = s.SetPid(p.ID, 0)
	got, _ = s.Get(p.ID)
	if got.Pid != 0 {
		t.Fatalf("expected stopped (pid 0), got %d", got.Pid)
	}
}

func TestStore_Persistence(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	p := &Profile{Provider: "antigravity", Name: "持久"}
	_ = s.Create(p)
	// 新实例从磁盘读
	again, _ := NewStore(dir).List("antigravity")
	if len(again) != 1 || again[0].Name != "持久" {
		t.Fatalf("persistence failed: %+v", again)
	}
}

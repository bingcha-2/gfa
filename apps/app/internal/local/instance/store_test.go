package instance

import (
	"os"
	"path/filepath"
	"testing"
)

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

func TestStore_QuickConfigFieldsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	cw := int64(1_000_000)
	ac := int64(900_000)
	p := &Profile{
		Provider:           "codex",
		Name:               "增强",
		LaunchMode:         "cli",
		AppSpeed:           "fast",
		FollowLocalAccount: true,
		QuickContextWindow: &cw,
		QuickAutoCompact:   &ac,
	}
	if err := s.Create(p); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 从磁盘重新读取,确认新字段持久化且指针值正确。
	got, ok := NewStore(dir).Get(p.ID)
	if !ok {
		t.Fatal("Get after reload failed")
	}
	if got.LaunchMode != "cli" {
		t.Fatalf("LaunchMode lost: %q", got.LaunchMode)
	}
	if got.AppSpeed != "fast" {
		t.Fatalf("AppSpeed lost: %q", got.AppSpeed)
	}
	if !got.FollowLocalAccount {
		t.Fatal("FollowLocalAccount lost")
	}
	if got.QuickContextWindow == nil || *got.QuickContextWindow != cw {
		t.Fatalf("QuickContextWindow lost: %v", got.QuickContextWindow)
	}
	if got.QuickAutoCompact == nil || *got.QuickAutoCompact != ac {
		t.Fatalf("QuickAutoCompact lost: %v", got.QuickAutoCompact)
	}
}

func TestStore_DefaultsOnCreate(t *testing.T) {
	s := NewStore(t.TempDir())
	p := &Profile{Provider: "codex", Name: "默认"}
	if err := s.Create(p); err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, _ := s.Get(p.ID)
	// LaunchMode 默认 "gui",AppSpeed 默认 "standard"。
	if got.LaunchMode != LaunchModeGUI {
		t.Fatalf("LaunchMode default wrong: %q", got.LaunchMode)
	}
	if got.AppSpeed != AppSpeedStandard {
		t.Fatalf("AppSpeed default wrong: %q", got.AppSpeed)
	}
	// 未设置的快捷配置保持 nil(代表“未配置/沿用官方”)。
	if got.QuickContextWindow != nil || got.QuickAutoCompact != nil {
		t.Fatalf("quick config should default nil: cw=%v ac=%v", got.QuickContextWindow, got.QuickAutoCompact)
	}
}

func TestStore_ForwardMigrationLegacyJSON(t *testing.T) {
	dir := t.TempDir()
	// 旧版 JSON:没有 launchMode/appSpeed/followLocalAccount/quick* 字段。
	legacy := `[
  {"id":"old-1","provider":"codex","name":"旧实例","userDataDir":"/tmp/old","createdAt":1}
]`
	if err := os.WriteFile(filepath.Join(dir, "instances.json"), []byte(legacy), 0o600); err != nil {
		t.Fatalf("seed legacy: %v", err)
	}

	s := NewStore(dir)
	got, ok := s.Get("old-1")
	if !ok {
		t.Fatal("legacy profile not loaded")
	}
	// 前向迁移:缺失字段被填充为安全默认,而非空字符串。
	if got.LaunchMode != LaunchModeGUI {
		t.Fatalf("legacy LaunchMode not migrated: %q", got.LaunchMode)
	}
	if got.AppSpeed != AppSpeedStandard {
		t.Fatalf("legacy AppSpeed not migrated: %q", got.AppSpeed)
	}
	// 旧字段保持不变。
	if got.Name != "旧实例" || got.UserDataDir != "/tmp/old" {
		t.Fatalf("legacy core fields corrupted: %+v", got)
	}
	// List 也应迁移。
	list, _ := s.List("codex")
	if len(list) != 1 || list[0].LaunchMode != LaunchModeGUI {
		t.Fatalf("List did not migrate: %+v", list)
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

// All 返回全部 provider 的实例(按 createdAt 升序);供数据迁移导出用。
func TestStore_All(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	_ = s.Create(&Profile{Provider: "codex", Name: "c"})
	_ = s.Create(&Profile{Provider: "antigravity", Name: "a"})
	all := s.All()
	if len(all) != 2 {
		t.Fatalf("All len=%d, want 2", len(all))
	}
}

// Replace 用给定列表整体替换实例库(数据迁移导入用)。
func TestStore_Replace(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	_ = s.Create(&Profile{Provider: "codex", Name: "old"})
	if err := s.Replace([]*Profile{{ID: "x1", Provider: "codex", Name: "new", CreatedAt: 1}}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	all := s.All()
	if len(all) != 1 || all[0].Name != "new" || all[0].ID != "x1" {
		t.Fatalf("Replace wrong: %+v", all)
	}
	// 迁移字段对 Replace 后的读取仍生效。
	if all[0].LaunchMode != LaunchModeGUI {
		t.Fatalf("Replace should migrate defaults: %+v", all[0])
	}
}

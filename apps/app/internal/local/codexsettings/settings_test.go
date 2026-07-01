package codexsettings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaultsWhenMissing(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	got := store.Load()
	want := DefaultSettings()
	if got != want {
		t.Fatalf("Load() defaults = %+v, want %+v", got, want)
	}
	// 缺省时不应写盘
	if _, err := os.Stat(filepath.Join(dir, fileName)); !os.IsNotExist(err) {
		t.Fatalf("Load() must not create file when missing, stat err = %v", err)
	}
}

func TestDefaultSettingsValues(t *testing.T) {
	d := DefaultSettings()
	if d.CodexAppPath != "" {
		t.Errorf("CodexAppPath default = %q, want empty", d.CodexAppPath)
	}
	if d.RestartAppPath != "" {
		t.Errorf("RestartAppPath default = %q, want empty", d.RestartAppPath)
	}
	if !d.LaunchOnSwitch {
		t.Errorf("LaunchOnSwitch default = false, want true")
	}
	if d.RestartAppOnSwitch {
		t.Errorf("RestartAppOnSwitch default = true, want false")
	}
	if !d.ShowApiEntry {
		t.Errorf("ShowApiEntry default = false, want true")
	}
	if d.FilterMemory {
		t.Errorf("FilterMemory default = true, want false")
	}
	if d.ShowCodeReviewQuota {
		t.Errorf("ShowCodeReviewQuota default = true, want false")
	}
}

func TestSaveThenLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	in := Settings{
		CodexAppPath:        "/Applications/Codex.app",
		LaunchOnSwitch:      false,
		RestartAppOnSwitch:  true,
		RestartAppPath:      "/Applications/Cursor.app",
		ShowApiEntry:        false,
		FilterMemory:        true,
		ShowCodeReviewQuota: true,
	}
	if err := store.Save(in); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	got := NewStore(dir).Load()
	if got != in {
		t.Fatalf("round-trip = %+v, want %+v", got, in)
	}
}

func TestSaveIsAtomicNoTempLeftover(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	if err := store.Save(DefaultSettings()); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir error = %v", err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("Save() left temp file %q", e.Name())
		}
	}
}

func TestLoadCorruptFileFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := NewStore(dir).Load()
	if got != DefaultSettings() {
		t.Fatalf("corrupt Load() = %+v, want defaults", got)
	}
}

func TestLoadPartialJSONKeepsDefaultsForMissingKeys(t *testing.T) {
	dir := t.TempDir()
	// 只写 launchOnSwitch=false,其余字段应保留默认
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(`{"launchOnSwitch":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := NewStore(dir).Load()
	if got.LaunchOnSwitch {
		t.Errorf("LaunchOnSwitch = true, want false from file")
	}
	if !got.ShowApiEntry {
		t.Errorf("ShowApiEntry = false, want default true for missing key")
	}
}

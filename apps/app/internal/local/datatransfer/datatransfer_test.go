package datatransfer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func sampleSnapshot() Snapshot {
	return Snapshot{
		Config: map[string]any{
			"language":          "zh-CN",
			"quotaMinutes":      float64(10),
			"routingStrategy":   "priority",
			"webdavSyncEnabled": true,
		},
		Instances: []InstanceProfile{
			{
				ID: "i1", Provider: "codex", Name: "工作", UserDataDir: "/tmp/a",
				ExtraArgs: "--foo", BindAccountID: "acc-1", CreatedAt: 100,
				LastLaunchedAt: 999, Pid: 4321,
			},
			{ID: "i2", Provider: "antigravity", Name: "备用", CreatedAt: 200},
		},
	}
}

func TestExport_RoundTrip(t *testing.T) {
	in := sampleSnapshot()

	data, err := Export(in)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// bundle 必须是版本化、带 schema 的信封
	var env struct {
		Schema     string `json:"schema"`
		Version    int    `json:"version"`
		ExportedAt string `json:"exportedAt"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("bundle not valid json: %v", err)
	}
	if env.Schema != Schema {
		t.Fatalf("schema = %q, want %q", env.Schema, Schema)
	}
	if env.Version != Version {
		t.Fatalf("version = %d, want %d", env.Version, Version)
	}
	if env.ExportedAt == "" {
		t.Fatal("exportedAt should be set")
	}

	out, err := Import(data)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if out.Config["language"] != "zh-CN" {
		t.Fatalf("config lost: %+v", out.Config)
	}
	if len(out.Instances) != 2 {
		t.Fatalf("instances = %d, want 2", len(out.Instances))
	}
	if out.Instances[0].Name != "工作" || out.Instances[0].BindAccountID != "acc-1" {
		t.Fatalf("instance fields lost: %+v", out.Instances[0])
	}
}

func TestImport_SanitizesRuntimeFields(t *testing.T) {
	data, err := Export(sampleSnapshot())
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	out, err := Import(data)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	// 运行态(pid/lastLaunchedAt)绝不应跨机器还原
	for _, p := range out.Instances {
		if p.Pid != 0 || p.LastLaunchedAt != 0 {
			t.Fatalf("runtime fields must be cleared on import: %+v", p)
		}
	}
}

func TestImport_RejectsBadInput(t *testing.T) {
	if _, err := Import([]byte("not json")); err == nil {
		t.Fatal("expected error for invalid json")
	}
	// 错误 schema
	bad, _ := json.Marshal(map[string]any{"schema": "other", "version": Version})
	if _, err := Import(bad); err == nil {
		t.Fatal("expected error for wrong schema")
	}
	// 错误版本
	badVer, _ := json.Marshal(map[string]any{"schema": Schema, "version": Version + 1})
	if _, err := Import(badVer); err == nil {
		t.Fatal("expected error for wrong version")
	}
}

func TestExportFile_ImportFile_TempDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "backup.json")

	if err := ExportFile(path, sampleSnapshot()); err != nil {
		t.Fatalf("ExportFile: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not written: %v", err)
	}

	out, err := ImportFile(path)
	if err != nil {
		t.Fatalf("ImportFile: %v", err)
	}
	if len(out.Instances) != 2 || out.Config["language"] != "zh-CN" {
		t.Fatalf("round trip via file failed: %+v", out)
	}
}

func TestImportFile_MissingFile(t *testing.T) {
	if _, err := ImportFile(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestExport_EmptySnapshotStable(t *testing.T) {
	// 空快照也应产出合法 bundle(空切片而非 null,便于消费端)
	data, err := Export(Snapshot{})
	if err != nil {
		t.Fatalf("Export empty: %v", err)
	}
	out, err := Import(data)
	if err != nil {
		t.Fatalf("Import empty: %v", err)
	}
	if out.Instances == nil {
		t.Fatal("instances should be non-nil empty slice")
	}
	if out.Config == nil {
		t.Fatal("config should be non-nil empty map")
	}
}

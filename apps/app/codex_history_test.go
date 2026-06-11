package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestRetagRolloutFilePreservesRestAndMtime(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "2026", "05", "25")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-test.jsonl")
	content := `{"type":"session_meta","payload":{"id":"s1","cwd":"/x","model_provider":"openai"}}
{"type":"event","timestamp":"2026-05-25T11:58:40.668Z"}
{"type":"event","data":"keep this 中文"}
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	changed, err := retagRolloutFile(path, "bingchaai")
	if err != nil || !changed {
		t.Fatalf("retag failed changed=%v err=%v", changed, err)
	}

	got, _ := os.ReadFile(path)
	if !strings.Contains(string(got), `"model_provider":"bingchaai"`) {
		t.Fatalf("provider 未改写:\n%s", got)
	}
	// 后续行必须原样保留。
	if !strings.Contains(string(got), `"keep this 中文"`) {
		t.Fatalf("后续行丢失:\n%s", got)
	}
	if !strings.Contains(string(got), `"timestamp":"2026-05-25T11:58:40.668Z"`) {
		t.Fatalf("第二行丢失:\n%s", got)
	}
	// 行数不变(末尾换行保留)。
	if a, b := strings.Count(content, "\n"), strings.Count(string(got), "\n"); a != b {
		t.Fatalf("换行数变化 %d -> %d", a, b)
	}
	// mtime 应被保留。
	info, _ := os.Stat(path)
	if !info.ModTime().Equal(oldTime) {
		t.Fatalf("mtime 未保留: got %v want %v", info.ModTime(), oldTime)
	}

	// 幂等:已对齐则不再改写。
	changed2, err := retagRolloutFile(path, "bingchaai")
	if err != nil || changed2 {
		t.Fatalf("应幂等 changed2=%v err=%v", changed2, err)
	}
}

func TestAlignRolloutProvidersWalksDirs(t *testing.T) {
	home := t.TempDir()
	for _, sub := range []string{"sessions/2026/05/25", "archived_sessions/2026/04"} {
		dir := filepath.Join(home, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		f := filepath.Join(dir, "rollout-x.jsonl")
		os.WriteFile(f, []byte(`{"type":"session_meta","payload":{"id":"a","model_provider":"openai"}}`+"\n"), 0o644)
	}
	// 一个非 rollout 文件不应被处理。
	os.WriteFile(filepath.Join(home, "sessions", "other.jsonl"), []byte("{}"), 0o644)

	changed, err := alignRolloutProviders(home, "bingchaai")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if changed != 2 {
		t.Fatalf("changed=%d want 2", changed)
	}
}

func TestAlignSQLiteProviders(t *testing.T) {
	home := t.TempDir()
	dbPath := filepath.Join(home, codexStateDBFile)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		model_provider TEXT,
		has_user_event INTEGER,
		first_user_message TEXT,
		thread_source TEXT
	)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO threads VALUES
		('a','openai',0,'hi',''),
		('b','bingchaai',1,'yo','user'),
		('c','openai',0,'',NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	rows, skipped, err := alignSQLiteProviders(home, "bingchaai")
	if err != nil {
		t.Fatalf("align err: %v", err)
	}
	if skipped {
		t.Fatalf("不应跳过有效库")
	}
	// a 和 c 的 provider 需要更新(b 已是 bingchaai)。
	if rows < 2 {
		t.Fatalf("rows=%d want >=2", rows)
	}

	db, _ = sql.Open("sqlite", dbPath)
	defer db.Close()
	var prov string
	var hasEvent int
	var src string
	db.QueryRow("SELECT model_provider, has_user_event, thread_source FROM threads WHERE id='a'").
		Scan(&prov, &hasEvent, &src)
	if prov != "bingchaai" || hasEvent != 1 || src != "user" {
		t.Fatalf("a 行未正确修复: provider=%s hasEvent=%d src=%s", prov, hasEvent, src)
	}
}

func TestAlignSQLiteMissingDB(t *testing.T) {
	home := t.TempDir()
	rows, skipped, err := alignSQLiteProviders(home, "bingchaai")
	if err != nil || rows != 0 || skipped {
		t.Fatalf("缺库应静默返回: rows=%d skipped=%v err=%v", rows, skipped, err)
	}
}

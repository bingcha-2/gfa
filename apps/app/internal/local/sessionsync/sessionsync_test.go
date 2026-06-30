package sessionsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeRollout 造一个最小 codex rollout-*.jsonl:首行 session_meta,后跟若干事件行。
func writeRollout(t *testing.T, path, sessionID, cwd string, extraLines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir rollout parent: %v", err)
	}
	meta := map[string]any{
		"type":    "session_meta",
		"payload": map[string]any{"id": sessionID, "cwd": cwd, "model_provider": "openai"},
	}
	b, _ := json.Marshal(meta)
	content := string(b) + "\n"
	for _, ln := range extraLines {
		content += ln + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
}

// writeSessionIndex 写 session_index.jsonl。
func writeSessionIndex(t *testing.T, dataDir string, lines ...string) {
	t.Helper()
	content := ""
	for _, ln := range lines {
		content += ln + "\n"
	}
	if err := os.WriteFile(filepath.Join(dataDir, "session_index.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatalf("write session index: %v", err)
	}
}

// tokenCountLine 造一行 codex token_count event_msg。
func tokenCountLine(input, output, total int) string {
	v := map[string]any{
		"type": "event_msg",
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"total_token_usage": map[string]any{
					"input_tokens":  input,
					"output_tokens": output,
					"total_tokens":  total,
				},
			},
		},
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func TestListSessionsAcrossInstances_DedupesByIDAndCountsLocations(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	// 同一会话 s1 出现在两个实例;s2 仅在 a。
	writeRollout(t, filepath.Join(a, "sessions", "2026", "06", "01", "rollout-s1.jsonl"), "s1", "/proj/one")
	writeRollout(t, filepath.Join(b, "sessions", "2026", "06", "01", "rollout-s1.jsonl"), "s1", "/proj/one")
	writeRollout(t, filepath.Join(a, "sessions", "2026", "06", "01", "rollout-s2.jsonl"), "s2", "/proj/two")
	writeSessionIndex(t, a,
		`{"id":"s1","thread_name":"First","updated_at":"2026-06-01T10:00:00Z"}`,
		`{"id":"s2","thread_name":"Second","updated_at":"2026-06-02T10:00:00Z"}`,
	)
	writeSessionIndex(t, b, `{"id":"s1","thread_name":"First","updated_at":"2026-06-01T10:00:00Z"}`)

	instances := []Instance{
		{ID: "a", Name: "Inst A", DataDir: a, Running: true},
		{ID: "b", Name: "Inst B", DataDir: b, Running: false},
	}
	got, err := ListSessions(instances, SearchFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 sessions, got %d: %+v", len(got), got)
	}
	// s2 较新,排前。
	if got[0].SessionID != "s2" {
		t.Fatalf("want s2 first (newer), got %q", got[0].SessionID)
	}
	var s1 *SessionRecord
	for i := range got {
		if got[i].SessionID == "s1" {
			s1 = &got[i]
		}
	}
	if s1 == nil {
		t.Fatal("s1 missing")
	}
	if s1.Title != "First" || s1.Cwd != "/proj/one" {
		t.Fatalf("s1 meta wrong: %+v", s1)
	}
	if s1.LocationCount != 2 || len(s1.Locations) != 2 {
		t.Fatalf("s1 should be in 2 instances, got %d", s1.LocationCount)
	}
	// running 标记随实例传入。
	var runningA bool
	for _, loc := range s1.Locations {
		if loc.InstanceID == "a" {
			runningA = loc.Running
		}
	}
	if !runningA {
		t.Fatalf("instance a running flag should propagate")
	}
}

func TestListSessions_TitleFilter(t *testing.T) {
	a := t.TempDir()
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s1.jsonl"), "s1", "/p")
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s2.jsonl"), "s2", "/p")
	writeSessionIndex(t, a,
		`{"id":"s1","thread_name":"Apple pie"}`,
		`{"id":"s2","thread_name":"Banana split"}`,
	)
	got, err := ListSessions([]Instance{{ID: "a", DataDir: a}}, SearchFilter{TitleQuery: "apple"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SessionID != "s1" {
		t.Fatalf("title filter wrong: %+v", got)
	}
}

func TestListSessions_ContentFilter(t *testing.T) {
	a := t.TempDir()
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s1.jsonl"), "s1", "/p",
		`{"type":"event_msg","payload":{"type":"user_message","message":"find the needle here"}}`)
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s2.jsonl"), "s2", "/p",
		`{"type":"event_msg","payload":{"type":"user_message","message":"nothing relevant"}}`)
	got, err := ListSessions([]Instance{{ID: "a", DataDir: a}}, SearchFilter{ContentQuery: "NEEDLE"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SessionID != "s1" {
		t.Fatalf("content filter wrong: %+v", got)
	}
}

func TestTokenStats(t *testing.T) {
	a := t.TempDir()
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s1.jsonl"), "s1", "/p",
		tokenCountLine(10, 5, 15),
		tokenCountLine(100, 50, 150)) // 取最后一条(最新累计)。
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s2.jsonl"), "s2", "/p") // 无 token 行。

	got, err := TokenStats([]Instance{{ID: "a", DataDir: a}}, []string{"s1", "s2", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 stats (only s1 has tokens), got %d: %+v", len(got), got)
	}
	if got[0].SessionID != "s1" || got[0].InputTokens != 100 || got[0].OutputTokens != 50 || got[0].TotalTokens != 150 {
		t.Fatalf("token stats wrong: %+v", got[0])
	}
}

func TestTokenStats_EmptyRequest(t *testing.T) {
	got, err := TokenStats(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("empty request should yield empty, got %+v", got)
	}
}

func TestMoveToTrash_RemovesRolloutAndIndexEntry(t *testing.T) {
	a := t.TempDir()
	trash := t.TempDir()
	rollout := filepath.Join(a, "sessions", "2026", "06", "01", "rollout-s1.jsonl")
	writeRollout(t, rollout, "s1", "/proj")
	writeSessionIndex(t, a,
		`{"id":"s1","thread_name":"Doomed"}`,
		`{"id":"s2","thread_name":"Kept"}`,
	)
	inst := Instance{ID: "a", Name: "Inst A", DataDir: a}

	sum, err := MoveToTrash([]Instance{inst}, []string{"s1"}, trash)
	if err != nil {
		t.Fatal(err)
	}
	if sum.TrashedSessionCount != 1 || sum.TrashedInstanceCount != 1 {
		t.Fatalf("trash summary wrong: %+v", sum)
	}
	if _, err := os.Stat(rollout); !os.IsNotExist(err) {
		t.Fatalf("rollout should be moved away, stat err=%v", err)
	}
	// session_index 应移除 s1、保留 s2。
	idx, _ := os.ReadFile(filepath.Join(a, "session_index.jsonl"))
	if got := string(idx); contains(got, `"id":"s1"`) || !contains(got, `"id":"s2"`) {
		t.Fatalf("index not rewritten correctly: %q", got)
	}
	// 废纸篓应能列出。
	trashed, err := ListTrashed(trash)
	if err != nil {
		t.Fatal(err)
	}
	if len(trashed) != 1 || trashed[0].SessionID != "s1" {
		t.Fatalf("trashed listing wrong: %+v", trashed)
	}
	if trashed[0].Title != "Doomed" || trashed[0].Cwd != "/proj" {
		t.Fatalf("trashed meta wrong: %+v", trashed[0])
	}
}

func TestMoveToTrash_EmptySelection(t *testing.T) {
	if _, err := MoveToTrash(nil, nil, t.TempDir()); err == nil {
		t.Fatal("expected error for empty selection")
	}
}

func TestRestoreFromTrash_RoundTrip(t *testing.T) {
	a := t.TempDir()
	trash := t.TempDir()
	rollout := filepath.Join(a, "sessions", "2026", "06", "01", "rollout-s1.jsonl")
	writeRollout(t, rollout, "s1", "/proj")
	writeSessionIndex(t, a, `{"id":"s1","thread_name":"Roundtrip"}`)
	inst := Instance{ID: "a", Name: "Inst A", DataDir: a}

	if _, err := MoveToTrash([]Instance{inst}, []string{"s1"}, trash); err != nil {
		t.Fatalf("move to trash: %v", err)
	}
	if _, err := os.Stat(rollout); !os.IsNotExist(err) {
		t.Fatalf("rollout should be gone after trash")
	}

	sum, err := RestoreFromTrash([]string{"s1"}, trash)
	if err != nil {
		t.Fatal(err)
	}
	if sum.RestoredSessionCount != 1 || sum.RestoredInstanceCount != 1 {
		t.Fatalf("restore summary wrong: %+v", sum)
	}
	if _, err := os.Stat(rollout); err != nil {
		t.Fatalf("rollout should be restored to original path: %v", err)
	}
	// 索引重新含 s1。
	idx, _ := os.ReadFile(filepath.Join(a, "session_index.jsonl"))
	if !contains(string(idx), `"id":"s1"`) {
		t.Fatalf("index should contain s1 after restore: %q", string(idx))
	}
	// 废纸篓清空。
	trashed, _ := ListTrashed(trash)
	if len(trashed) != 0 {
		t.Fatalf("trash should be empty after restore: %+v", trashed)
	}
}

func TestRestoreFromTrash_EmptySelection(t *testing.T) {
	if _, err := RestoreFromTrash(nil, t.TempDir()); err == nil {
		t.Fatal("expected error for empty selection")
	}
}

func TestRestoreFromTrash_RejectsConflictingExistingRollout(t *testing.T) {
	a := t.TempDir()
	trash := t.TempDir()
	rollout := filepath.Join(a, "sessions", "2026", "06", "01", "rollout-s1.jsonl")
	writeRollout(t, rollout, "s1", "/proj")
	writeSessionIndex(t, a, `{"id":"s1","thread_name":"Doomed"}`)
	inst := Instance{ID: "a", Name: "Inst A", DataDir: a}
	if _, err := MoveToTrash([]Instance{inst}, []string{"s1"}, trash); err != nil {
		t.Fatalf("move: %v", err)
	}
	// 在原位置放一个不同会话的同名文件,恢复应被拒以防覆盖。
	writeRollout(t, rollout, "other-session", "/proj")

	if _, err := RestoreFromTrash([]string{"s1"}, trash); err == nil {
		t.Fatal("expected conflict error when target holds a different session")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

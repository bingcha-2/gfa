package sessionsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// providerMetaLine 造一个带 model_provider 的 session_meta 首行。
func providerMetaLine(sessionID, cwd, provider string) string {
	v := map[string]any{
		"type":    "session_meta",
		"payload": map[string]any{"id": sessionID, "cwd": cwd, "model_provider": provider},
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// writeConfigProvider 在实例目录写一份最小 config.toml,指定 model_provider。
func writeConfigProvider(t *testing.T, dataDir, provider string) {
	t.Helper()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir dataDir: %v", err)
	}
	content := "model_provider = \"" + provider + "\"\n"
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(content), 0o644); err != nil {
		t.Fatalf("write config.toml: %v", err)
	}
}

// ── SyncToInstance ──

func TestSyncToInstance_CopiesMissingSessionsToTarget(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	// 源实例有 s1(带内容),目标实例没有。
	srcRollout := filepath.Join(src, "sessions", "2026", "06", "30", "rollout-s1.jsonl")
	writeRollout(t, srcRollout, "s1", "/proj/one",
		`{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`)
	writeSessionIndex(t, src, `{"id":"s1","thread_name":"来源会话"}`)

	instances := []Instance{
		{ID: "src", Name: "源", DataDir: src},
		{ID: "dst", Name: "目标", DataDir: dst},
	}
	sum, err := SyncToInstance(instances, []string{"s1"}, "dst")
	if err != nil {
		t.Fatal(err)
	}
	if sum.SyncedSessionCount != 1 || sum.TargetInstanceID != "dst" {
		t.Fatalf("summary wrong: %+v", sum)
	}
	// 目标实例应出现相同相对路径的 rollout。
	dstRollout := filepath.Join(dst, "sessions", "2026", "06", "30", "rollout-s1.jsonl")
	if _, err := os.Stat(dstRollout); err != nil {
		t.Fatalf("target rollout should exist: %v", err)
	}
	// 目标 session_index 应含 s1。
	idx, _ := os.ReadFile(filepath.Join(dst, "session_index.jsonl"))
	if !contains(string(idx), `"id":"s1"`) {
		t.Fatalf("target index should contain s1: %q", string(idx))
	}
}

func TestSyncToInstance_SkipsSessionsAlreadyInTarget(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	writeRollout(t, filepath.Join(src, "sessions", "rollout-s1.jsonl"), "s1", "/proj")
	writeRollout(t, filepath.Join(dst, "sessions", "rollout-s1.jsonl"), "s1", "/proj")
	instances := []Instance{
		{ID: "src", Name: "源", DataDir: src},
		{ID: "dst", Name: "目标", DataDir: dst},
	}
	sum, err := SyncToInstance(instances, []string{"s1"}, "dst")
	if err != nil {
		t.Fatal(err)
	}
	if sum.SyncedSessionCount != 0 || sum.SkippedExistingCount != 1 {
		t.Fatalf("should skip existing: %+v", sum)
	}
}

func TestSyncToInstance_MissingSessionCounted(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	writeRollout(t, filepath.Join(src, "sessions", "rollout-s1.jsonl"), "s1", "/proj")
	instances := []Instance{
		{ID: "src", Name: "源", DataDir: src},
		{ID: "dst", Name: "目标", DataDir: dst},
	}
	sum, err := SyncToInstance(instances, []string{"missing"}, "dst")
	if err != nil {
		t.Fatal(err)
	}
	if sum.SyncedSessionCount != 0 || sum.MissingSessionCount != 1 {
		t.Fatalf("missing should be counted: %+v", sum)
	}
}

func TestSyncToInstance_RewritesProviderToTargetConfig(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	srcRollout := filepath.Join(src, "sessions", "rollout-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(srcRollout), 0o755); err != nil {
		t.Fatal(err)
	}
	// 源里 provider=openai;目标 config.toml 指定 provider=relay。
	if err := os.WriteFile(srcRollout, []byte(providerMetaLine("s1", "/proj", "openai")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeConfigProvider(t, dst, "relay")
	instances := []Instance{
		{ID: "src", Name: "源", DataDir: src},
		{ID: "dst", Name: "目标", DataDir: dst},
	}
	if _, err := SyncToInstance(instances, []string{"s1"}, "dst"); err != nil {
		t.Fatal(err)
	}
	dstRollout := filepath.Join(dst, "sessions", "rollout-s1.jsonl")
	data, _ := os.ReadFile(dstRollout)
	if !contains(string(data), `"model_provider":"relay"`) {
		t.Fatalf("target rollout provider should be rewritten to relay: %q", string(data))
	}
}

func TestSyncToInstance_EmptySelectionErrors(t *testing.T) {
	if _, err := SyncToInstance(nil, nil, "dst"); err == nil {
		t.Fatal("expected error for empty session selection")
	}
}

func TestSyncToInstance_UnknownTargetErrors(t *testing.T) {
	src := t.TempDir()
	instances := []Instance{{ID: "src", Name: "源", DataDir: src}}
	if _, err := SyncToInstance(instances, []string{"s1"}, "nope"); err == nil {
		t.Fatal("expected error for unknown target instance")
	}
}

// ── SyncThreadsAcrossInstances ──

func TestSyncThreadsAcrossInstances_AddsMissingToEachInstance(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	// a 有 s1,b 有 s2;同步后两边都应有 s1、s2。
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s1.jsonl"), "s1", "/proj/a")
	writeSessionIndex(t, a, `{"id":"s1","thread_name":"A会话"}`)
	writeRollout(t, filepath.Join(b, "sessions", "rollout-s2.jsonl"), "s2", "/proj/b")
	writeSessionIndex(t, b, `{"id":"s2","thread_name":"B会话"}`)

	instances := []Instance{
		{ID: "a", Name: "A", DataDir: a},
		{ID: "b", Name: "B", DataDir: b},
	}
	sum, err := SyncThreadsAcrossInstances(instances)
	if err != nil {
		t.Fatal(err)
	}
	if sum.ThreadUniverseCount != 2 {
		t.Fatalf("universe should have 2 threads: %+v", sum)
	}
	if sum.TotalAddedThreadCount != 2 {
		t.Fatalf("should add s2->a and s1->b (2 adds): %+v", sum)
	}
	// a 现在应有 s2,b 应有 s1。
	if _, err := os.Stat(filepath.Join(a, "sessions", "rollout-s2.jsonl")); err != nil {
		t.Fatalf("s2 should be copied into a: %v", err)
	}
	if _, err := os.Stat(filepath.Join(b, "sessions", "rollout-s1.jsonl")); err != nil {
		t.Fatalf("s1 should be copied into b: %v", err)
	}
	// session_index 应各自补齐。
	aIdx, _ := os.ReadFile(filepath.Join(a, "session_index.jsonl"))
	if !contains(string(aIdx), `"id":"s2"`) {
		t.Fatalf("a index should gain s2: %q", string(aIdx))
	}
}

func TestSyncThreadsAcrossInstances_NoopWhenAllInSync(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	writeRollout(t, filepath.Join(a, "sessions", "rollout-s1.jsonl"), "s1", "/proj")
	writeRollout(t, filepath.Join(b, "sessions", "rollout-s1.jsonl"), "s1", "/proj")
	instances := []Instance{
		{ID: "a", Name: "A", DataDir: a},
		{ID: "b", Name: "B", DataDir: b},
	}
	sum, err := SyncThreadsAcrossInstances(instances)
	if err != nil {
		t.Fatal(err)
	}
	if sum.TotalAddedThreadCount != 0 || sum.MutatedInstanceCount != 0 {
		t.Fatalf("in-sync instances should be a no-op: %+v", sum)
	}
}

func TestSyncThreadsAcrossInstances_RequiresTwoInstances(t *testing.T) {
	a := t.TempDir()
	instances := []Instance{{ID: "a", Name: "A", DataDir: a}}
	if _, err := SyncThreadsAcrossInstances(instances); err == nil {
		t.Fatal("expected error with fewer than two instances")
	}
}

// ── VisibilityRepair ──

func TestVisibilityRepair_RewritesRolloutProviderToInstanceConfig(t *testing.T) {
	a := t.TempDir()
	// config 指定 provider=relay,但 rollout 里 provider=openai → 应被校正为 relay。
	writeConfigProvider(t, a, "relay")
	rollout := filepath.Join(a, "sessions", "rollout-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollout, []byte(providerMetaLine("s1", "/proj", "openai")+"\n"+
		`{"type":"event_msg","payload":{"type":"user_message","message":"x"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	sum, err := VisibilityRepair([]Instance{{ID: "a", Name: "A", DataDir: a}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if sum.ChangedRolloutFileCount != 1 || sum.MutatedInstanceCount != 1 {
		t.Fatalf("should repair 1 rollout in 1 instance: %+v", sum)
	}
	data, _ := os.ReadFile(rollout)
	if !contains(string(data), `"model_provider":"relay"`) {
		t.Fatalf("rollout provider should be relay: %q", string(data))
	}
	// 事件行(非 session_meta)应保留。
	if !contains(string(data), `"user_message"`) {
		t.Fatalf("event lines must be preserved: %q", string(data))
	}
}

func TestVisibilityRepair_TargetProviderOverride(t *testing.T) {
	a := t.TempDir()
	writeConfigProvider(t, a, "relay")
	rollout := filepath.Join(a, "sessions", "rollout-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollout, []byte(providerMetaLine("s1", "/proj", "openai")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 显式覆盖 provider=forced,忽略 config。
	if _, err := VisibilityRepair([]Instance{{ID: "a", Name: "A", DataDir: a}}, "forced"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(rollout)
	if !contains(string(data), `"model_provider":"forced"`) {
		t.Fatalf("override provider should win: %q", string(data))
	}
}

func TestVisibilityRepair_NoopWhenAlreadyConsistent(t *testing.T) {
	a := t.TempDir()
	writeConfigProvider(t, a, "openai")
	rollout := filepath.Join(a, "sessions", "rollout-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollout, []byte(providerMetaLine("s1", "/proj", "openai")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := VisibilityRepair([]Instance{{ID: "a", Name: "A", DataDir: a}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if sum.ChangedRolloutFileCount != 0 || sum.MutatedInstanceCount != 0 {
		t.Fatalf("consistent instance should be a no-op: %+v", sum)
	}
}

// ── list helpers ──

func TestListRepairInstances_ReportsCurrentProvider(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	writeConfigProvider(t, a, "relay")
	// b 无 config → 默认 openai。
	instances := []Instance{
		{ID: "a", Name: "A", DataDir: a, Running: true},
		{ID: "b", Name: "B", DataDir: b},
	}
	opts, err := ListRepairInstances(instances)
	if err != nil {
		t.Fatal(err)
	}
	if len(opts) != 2 {
		t.Fatalf("want 2 instance options: %+v", opts)
	}
	byID := map[string]RepairInstanceOption{}
	for _, o := range opts {
		byID[o.ID] = o
	}
	if byID["a"].CurrentProvider != "relay" || byID["a"].Running != true {
		t.Fatalf("a should report relay+running: %+v", byID["a"])
	}
	if byID["b"].CurrentProvider != "openai" {
		t.Fatalf("b should default to openai: %+v", byID["b"])
	}
}

func TestListRepairProviders_CollectsFromConfigAndRollouts(t *testing.T) {
	a := t.TempDir()
	writeConfigProvider(t, a, "relay")
	rollout := filepath.Join(a, "sessions", "rollout-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	// rollout 里 provider=openai(与 config 的 relay 不同)→ 两个候选都应出现。
	if err := os.WriteFile(rollout, []byte(providerMetaLine("s1", "/proj", "openai")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := ListRepairProviders([]Instance{{ID: "a", Name: "A", DataDir: a}})
	if err != nil {
		t.Fatal(err)
	}
	if list.DefaultProvider != "relay" {
		t.Fatalf("default provider should come from config: %+v", list)
	}
	ids := map[string]bool{}
	for _, p := range list.Providers {
		ids[p.ID] = true
	}
	if !ids["relay"] || !ids["openai"] {
		t.Fatalf("providers should include config+rollout sources: %+v", list.Providers)
	}
}

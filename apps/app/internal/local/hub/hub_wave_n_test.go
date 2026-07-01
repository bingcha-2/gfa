package hub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeInstanceRollout 在给定 user-data-dir 下造一份最小 codex rollout 会话。
func writeInstanceRollout(t *testing.T, dataDir, sessionID, provider string) {
	t.Helper()
	dir := filepath.Join(dataDir, "sessions", "2026", "06", "30")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	line := `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"/proj","model_provider":"` + provider + `"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "rollout-"+sessionID+".jsonl"), []byte(line), 0o644); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
}

// ── SyncSessionsToInstance:从源实例恢复到目标实例 ──

func TestHub_SyncSessionsToInstance(t *testing.T) {
	h, _ := newHub(t)
	srcDir := filepath.Join(t.TempDir(), "src")
	dstDir := filepath.Join(t.TempDir(), "dst")
	writeInstanceRollout(t, srcDir, "sid1", "openai")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatalf("mkdir dst: %v", err)
	}
	src, _ := h.InstanceCreate("codex", "源", srcDir, "", "", "")
	dst, _ := h.InstanceCreate("codex", "目标", dstDir, "", "", "")
	_ = src

	sum, err := h.SyncSessionsToInstance([]string{"sid1"}, dst.ID)
	if err != nil {
		t.Fatalf("SyncSessionsToInstance: %v", err)
	}
	if sum.SyncedSessionCount != 1 || sum.TargetInstanceID != dst.ID {
		t.Fatalf("summary wrong: %+v", sum)
	}
	if _, err := os.Stat(filepath.Join(dstDir, "sessions", "2026", "06", "30", "rollout-sid1.jsonl")); err != nil {
		t.Fatalf("target should have the copied rollout: %v", err)
	}
}

// ── SyncThreadsAcrossInstances:两实例互补 ──

func TestHub_SyncThreadsAcrossInstances(t *testing.T) {
	h, _ := newHub(t)
	aDir := filepath.Join(t.TempDir(), "a")
	bDir := filepath.Join(t.TempDir(), "b")
	writeInstanceRollout(t, aDir, "s1", "openai")
	writeInstanceRollout(t, bDir, "s2", "openai")
	if _, err := h.InstanceCreate("codex", "A", aDir, "", "", ""); err != nil {
		t.Fatalf("create A: %v", err)
	}
	if _, err := h.InstanceCreate("codex", "B", bDir, "", "", ""); err != nil {
		t.Fatalf("create B: %v", err)
	}

	sum, err := h.SyncThreadsAcrossInstances()
	if err != nil {
		t.Fatalf("SyncThreadsAcrossInstances: %v", err)
	}
	if sum.ThreadUniverseCount != 2 || sum.TotalAddedThreadCount != 2 {
		t.Fatalf("expected 2 threads, 2 adds: %+v", sum)
	}
	if _, err := os.Stat(filepath.Join(aDir, "sessions", "2026", "06", "30", "rollout-s2.jsonl")); err != nil {
		t.Fatalf("s2 should be copied into A: %v", err)
	}
}

// ── RepairSessionVisibility + list helpers ──

func TestHub_RepairSessionVisibilityAndLists(t *testing.T) {
	h, _ := newHub(t)
	dir := filepath.Join(t.TempDir(), "udd")
	writeInstanceRollout(t, dir, "s1", "openai")
	// config.toml 指定 provider=relay → 修复应把 rollout 校正为 relay。
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("model_provider = \"relay\"\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := h.InstanceCreate("codex", "实例A", dir, "", "", ""); err != nil {
		t.Fatalf("create: %v", err)
	}

	// 候选实例列表应报告 current provider=relay。
	instOpts, err := h.ListVisibilityRepairInstances()
	if err != nil {
		t.Fatalf("ListVisibilityRepairInstances: %v", err)
	}
	if len(instOpts) != 1 || instOpts[0].CurrentProvider != "relay" {
		t.Fatalf("instance option wrong: %+v", instOpts)
	}
	// 候选 provider 列表应含 relay(config) 与 openai(rollout)。
	provs, err := h.ListVisibilityRepairProviders()
	if err != nil {
		t.Fatalf("ListVisibilityRepairProviders: %v", err)
	}
	if provs.DefaultProvider != "relay" {
		t.Fatalf("default provider wrong: %+v", provs)
	}

	sum, err := h.RepairSessionVisibility("")
	if err != nil {
		t.Fatalf("RepairSessionVisibility: %v", err)
	}
	if sum.ChangedRolloutFileCount != 1 {
		t.Fatalf("expected 1 changed rollout: %+v", sum)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "sessions", "2026", "06", "30", "rollout-s1.jsonl"))
	if want := `"model_provider":"relay"`; !strings.Contains(string(data), want) {
		t.Fatalf("rollout should be repaired to relay: %q", string(data))
	}
}

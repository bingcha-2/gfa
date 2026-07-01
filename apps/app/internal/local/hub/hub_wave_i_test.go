package hub

import (
	"os"
	"path/filepath"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/sessionsync"
)

// ── 账号组织(groups) ──

func TestHub_AccountGroups_CRUDAndAssign(t *testing.T) {
	h, _ := newHub(t)
	g, err := h.CreateAccountGroup("工作")
	if err != nil || g.Name != "工作" {
		t.Fatalf("CreateAccountGroup: %+v %v", g, err)
	}
	if _, err := h.RenameAccountGroup(g.ID, "私人"); err != nil {
		t.Fatalf("RenameAccountGroup: %v", err)
	}
	if _, err := h.AssignAccountsToGroup(g.ID, []string{"acc1", "acc2"}); err != nil {
		t.Fatalf("AssignAccountsToGroup: %v", err)
	}
	groups, err := h.ListAccountGroups()
	if err != nil || len(groups) != 1 || groups[0].Name != "私人" || len(groups[0].AccountIDs) != 2 {
		t.Fatalf("ListAccountGroups wrong: %+v %v", groups, err)
	}
	if h.GroupOfAccount("acc1") != g.ID {
		t.Fatalf("GroupOfAccount should map acc1 to %s", g.ID)
	}
	if _, err := h.RemoveAccountsFromGroup(g.ID, []string{"acc1"}); err != nil {
		t.Fatalf("RemoveAccountsFromGroup: %v", err)
	}
	if err := h.DeleteAccountGroup(g.ID); err != nil {
		t.Fatalf("DeleteAccountGroup: %v", err)
	}
	groups, _ = h.ListAccountGroups()
	if len(groups) != 0 {
		t.Fatalf("expected no groups after delete, got %+v", groups)
	}
}

// 删账号时应从所有分组里清掉该账号(membership 清理)。
func TestHub_DeleteAccount_CleansGroupMembership(t *testing.T) {
	h, _ := newHub(t)
	v, err := h.AddByToken(account.ProviderCodex, "rt", "at", "m@x.com")
	if err != nil {
		t.Fatalf("AddByToken: %v", err)
	}
	g, _ := h.CreateAccountGroup("g")
	if _, err := h.AssignAccountsToGroup(g.ID, []string{v.ID}); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	if err := h.DeleteAccount(v.ID); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	groups, _ := h.ListAccountGroups()
	if len(groups) != 1 || len(groups[0].AccountIDs) != 0 {
		t.Fatalf("deleted account should be removed from group: %+v", groups)
	}
}

// ── 显式当前号 get/set + 重排序 ──

func TestHub_CurrentAndSetCurrentAndReorder(t *testing.T) {
	h, _ := newHub(t)
	a, _ := h.AddByToken(account.ProviderCodex, "rt", "at", "a@x.com")
	b, _ := h.AddByToken(account.ProviderCodex, "rt", "at", "b@x.com")
	// 默认无优先级 -> current 为第一个(a)。
	cur, err := h.CurrentAccount(account.ProviderCodex)
	if err != nil || cur == nil || cur.ID != a.ID {
		t.Fatalf("expected a as default current: %+v %v", cur, err)
	}
	if err := h.SetCurrentAccount(account.ProviderCodex, b.ID); err != nil {
		t.Fatalf("SetCurrentAccount: %v", err)
	}
	cur, _ = h.CurrentAccount(account.ProviderCodex)
	if cur == nil || cur.ID != b.ID {
		t.Fatalf("current should be b: %+v", cur)
	}
	if err := h.ReorderAccounts(account.ProviderCodex, []string{b.ID, a.ID}); err != nil {
		t.Fatalf("ReorderAccounts: %v", err)
	}
	views, _ := h.ListAccounts(account.ProviderCodex)
	if len(views) != 2 || views[0].ID != b.ID {
		t.Fatalf("reordered list wrong: %+v", views)
	}
}

// ── 会话:从默认 Codex 主目录(CODEX_HOME)读 rollout(多实例已删) ──

func TestHub_ListSessions_FromDefaultCodexHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	h, _ := newHub(t)
	sessDir := filepath.Join(home, "sessions", "2026", "06", "30")
	if err := os.MkdirAll(sessDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rollout := filepath.Join(sessDir, "rollout-2026-06-30T00-00-00-sid1.jsonl")
	line := `{"type":"session_meta","payload":{"id":"sid1","cwd":"/proj"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(line), 0o644); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
	recs, err := h.ListSessions(sessionsync.SearchFilter{})
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(recs) != 1 || recs[0].SessionID != "sid1" {
		t.Fatalf("expected sid1 session from default codex home: %+v", recs)
	}
}

// ── Antigravity runtime 控制经 Platform 委托 ──

func TestHub_AntigravityRuntime_DelegatesToPlatform(t *testing.T) {
	h, fp := newHub(t)
	if err := h.AntigravityStartDefault(); err != nil {
		t.Fatalf("StartDefault: %v", err)
	}
	if err := h.AntigravityStopDefault(); err != nil {
		t.Fatalf("StopDefault: %v", err)
	}
	if err := h.AntigravityRestartDefault(); err != nil {
		t.Fatalf("RestartDefault: %v", err)
	}
	if err := h.AntigravityFocusDefault(); err != nil {
		t.Fatalf("FocusDefault: %v", err)
	}
	_ = h.AntigravityRuntimeStatus()
	if fp.agStartCount != 2 || fp.agStopCount != 2 || fp.agFocusCount != 1 || fp.agStatusCount != 1 {
		t.Fatalf("runtime delegation counts wrong: start=%d stop=%d focus=%d status=%d",
			fp.agStartCount, fp.agStopCount, fp.agFocusCount, fp.agStatusCount)
	}
}

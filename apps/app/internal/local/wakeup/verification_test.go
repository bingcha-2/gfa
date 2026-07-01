package wakeup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"bcai-wails/internal/local/account"
)

// resolver 造一个 id→account 的解析器(模拟 hub 的 acc.Get)。
func resolver(m map[string]*account.Account) AccountResolver {
	return func(id string) (*account.Account, error) {
		a, ok := m[id]
		if !ok {
			return nil, errors.New("not found: " + id)
		}
		return a, nil
	}
}

// keepAlivePassFail 造一个确定性 keepAlive:failFor 里的 id 失败,其余成功。
func keepAlivePassFail(failFor map[string]bool) KeepAliveFunc {
	return func(ctx context.Context, a *account.Account) (int64, error) {
		if failFor[a.ID] {
			return 0, errors.New("probe failed for " + a.ID)
		}
		return 1_700_000_222, nil
	}
}

func newVerify(t *testing.T, ka KeepAliveFunc, m map[string]*account.Account) *Verification {
	t.Helper()
	return NewVerification(t.TempDir(), "codex", ka, resolver(m))
}

func TestVerification_RunBatch_AggregatesPassFail(t *testing.T) {
	accts := map[string]*account.Account{
		"a": {ID: "a", Email: "a@y"},
		"b": {ID: "b", Email: "b@y"},
		"c": {ID: "c", Email: "c@y"},
	}
	v := newVerify(t, keepAlivePassFail(map[string]bool{"b": true}), accts)

	res, err := v.RunBatch(context.Background(), []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("RunBatch: %v", err)
	}
	if res.Total != 3 || res.PassCount != 2 || res.FailCount != 1 {
		t.Fatalf("aggregate wrong: %+v", res)
	}
	if len(res.Records) != 3 {
		t.Fatalf("expected 3 records, got %d", len(res.Records))
	}
	byID := map[string]VerifyResult{}
	for _, r := range res.Records {
		byID[r.AccountID] = r
	}
	if !byID["a"].Ok || byID["a"].Email != "a@y" {
		t.Fatalf("a should pass: %+v", byID["a"])
	}
	if byID["b"].Ok || byID["b"].Reason == "" {
		t.Fatalf("b should fail with reason: %+v", byID["b"])
	}
	if res.BatchID == "" || res.AtMs == 0 {
		t.Fatalf("batch id/at should be set: %+v", res)
	}
}

func TestVerification_RunBatch_DedupesAndSkipsUnknown(t *testing.T) {
	accts := map[string]*account.Account{"a": {ID: "a", Email: "a@y"}}
	v := newVerify(t, keepAlivePassFail(nil), accts)

	// 重复 id + 空白 + 未知 id:去重、丢空、未知记为失败(解析不到)。
	res, err := v.RunBatch(context.Background(), []string{"a", "a", " ", "ghost"})
	if err != nil {
		t.Fatalf("RunBatch: %v", err)
	}
	if res.Total != 2 { // a 与 ghost(去重后),空白丢弃
		t.Fatalf("expected total 2, got %d (%+v)", res.Total, res)
	}
	byID := map[string]VerifyResult{}
	for _, r := range res.Records {
		byID[r.AccountID] = r
	}
	if !byID["a"].Ok {
		t.Fatalf("a should pass: %+v", byID["a"])
	}
	if byID["ghost"].Ok || byID["ghost"].Reason == "" {
		t.Fatalf("ghost(unknown) should fail: %+v", byID["ghost"])
	}
}

func TestVerification_RunBatch_EmptyErrors(t *testing.T) {
	v := newVerify(t, keepAlivePassFail(nil), map[string]*account.Account{})
	if _, err := v.RunBatch(context.Background(), []string{"  ", ""}); err == nil {
		t.Fatal("empty selection should error")
	}
}

func TestVerification_State_PersistsLatestPerAccount(t *testing.T) {
	accts := map[string]*account.Account{
		"a": {ID: "a", Email: "a@y"},
		"b": {ID: "b", Email: "b@y"},
	}
	dir := t.TempDir()
	v := NewVerification(dir, "codex", keepAlivePassFail(map[string]bool{"b": true}), resolver(accts))
	if _, err := v.RunBatch(context.Background(), []string{"a", "b"}); err != nil {
		t.Fatalf("RunBatch: %v", err)
	}

	// 重开一个 Verification(同 dir),状态应从磁盘还原。
	v2 := NewVerification(dir, "codex", keepAlivePassFail(nil), resolver(accts))
	state, err := v2.LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(state) != 2 {
		t.Fatalf("expected 2 state items, got %d", len(state))
	}
	byID := map[string]VerifyResult{}
	for _, s := range state {
		byID[s.AccountID] = s
	}
	if !byID["a"].Ok || byID["b"].Ok {
		t.Fatalf("state pass/fail wrong: %+v", byID)
	}
}

func TestVerification_State_UpsertsLatest(t *testing.T) {
	accts := map[string]*account.Account{"a": {ID: "a", Email: "a@y"}}
	dir := t.TempDir()
	// 第一轮 a 失败,第二轮 a 成功 —— state 只保留最新(成功)。
	vFail := NewVerification(dir, "codex", keepAlivePassFail(map[string]bool{"a": true}), resolver(accts))
	_, _ = vFail.RunBatch(context.Background(), []string{"a"})
	vPass := NewVerification(dir, "codex", keepAlivePassFail(nil), resolver(accts))
	_, _ = vPass.RunBatch(context.Background(), []string{"a"})

	state, _ := vPass.LoadState()
	if len(state) != 1 || !state[0].Ok {
		t.Fatalf("state should keep latest (pass): %+v", state)
	}
}

func TestVerification_History_PersistsBatchesAndCaps(t *testing.T) {
	accts := map[string]*account.Account{"a": {ID: "a", Email: "a@y"}}
	dir := t.TempDir()
	v := NewVerification(dir, "codex", keepAlivePassFail(nil), resolver(accts))
	for i := 0; i < maxVerifyHistoryBatches+5; i++ {
		if _, err := v.RunBatch(context.Background(), []string{"a"}); err != nil {
			t.Fatalf("RunBatch %d: %v", i, err)
		}
	}
	hist, err := v.LoadHistory()
	if err != nil {
		t.Fatalf("LoadHistory: %v", err)
	}
	if len(hist) != maxVerifyHistoryBatches {
		t.Fatalf("history should cap at %d, got %d", maxVerifyHistoryBatches, len(hist))
	}
	// 新→旧:第一条应是最近的(AtMs 最大)。
	if hist[0].AtMs < hist[len(hist)-1].AtMs {
		t.Fatalf("history should be newest-first: %d vs %d", hist[0].AtMs, hist[len(hist)-1].AtMs)
	}
}

func TestVerification_DeleteHistory(t *testing.T) {
	accts := map[string]*account.Account{"a": {ID: "a", Email: "a@y"}}
	dir := t.TempDir()
	v := NewVerification(dir, "codex", keepAlivePassFail(nil), resolver(accts))
	r1, _ := v.RunBatch(context.Background(), []string{"a"})
	r2, _ := v.RunBatch(context.Background(), []string{"a"})

	n, err := v.DeleteHistory([]string{r1.BatchID, "", " "})
	if err != nil {
		t.Fatalf("DeleteHistory: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 deleted, got %d", n)
	}
	hist, _ := v.LoadHistory()
	if len(hist) != 1 || hist[0].BatchID != r2.BatchID {
		t.Fatalf("only r2 should remain: %+v", hist)
	}
}

func TestVerification_SingleTest(t *testing.T) {
	accts := map[string]*account.Account{
		"a": {ID: "a", Email: "a@y"},
		"b": {ID: "b", Email: "b@y"},
	}
	dir := t.TempDir()
	v := NewVerification(dir, "codex", keepAlivePassFail(map[string]bool{"b": true}), resolver(accts))

	rOk, err := v.SingleTest(context.Background(), "a")
	if err != nil {
		t.Fatalf("SingleTest a: %v", err)
	}
	if !rOk.Ok || rOk.Email != "a@y" {
		t.Fatalf("a should pass: %+v", rOk)
	}
	rFail, err := v.SingleTest(context.Background(), "b")
	if err != nil {
		t.Fatalf("SingleTest b: %v", err)
	}
	if rFail.Ok || rFail.Reason == "" {
		t.Fatalf("b should fail: %+v", rFail)
	}
	// 单测也应更新 state(可查最新)。
	state, _ := v.LoadState()
	if len(state) != 2 {
		t.Fatalf("single tests should upsert state, got %d", len(state))
	}
}

func TestVerification_SingleTest_UnknownIDErrors(t *testing.T) {
	v := newVerify(t, keepAlivePassFail(nil), map[string]*account.Account{})
	if _, err := v.SingleTest(context.Background(), "ghost"); err == nil {
		t.Fatal("single test of unknown id should error")
	}
}

func TestVerification_StateFile_CorruptToleratedAsEmpty(t *testing.T) {
	dir := t.TempDir()
	// 写坏文件,Load 应容忍返回空。
	path := filepath.Join(dir, "wakeup-verify-codex.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	v := NewVerification(dir, "codex", keepAlivePassFail(nil), resolver(map[string]*account.Account{}))
	state, err := v.LoadState()
	if err != nil {
		t.Fatalf("corrupt file should be tolerated: %v", err)
	}
	if len(state) != 0 {
		t.Fatalf("corrupt file should yield empty state, got %d", len(state))
	}
}

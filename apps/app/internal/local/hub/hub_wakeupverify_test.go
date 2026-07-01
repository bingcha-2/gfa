package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
)

// apikeyAcct 造一个 API Key 号:hub 注入的 keepAlive 对 API Key 号短路返回 (0,nil)(视为存活),
// 故不触网即可确定性 pass —— 用来测保活验证的「wiring」(hub → Verification → 真注入 keepAlive)。
func (h *Hub) addAPIKeyAcct(t *testing.T, p account.Provider, email string) string {
	t.Helper()
	a := &account.Account{
		Provider:    p,
		Email:       email,
		AuthKind:    account.AuthAPIKey,
		APIKey:      "sk-test",
		PoolEnabled: true,
	}
	if err := h.acc.Add(a); err != nil {
		t.Fatalf("add acct: %v", err)
	}
	return a.ID
}

func TestHub_WakeupVerifyBatch_AggregatesAndPersists(t *testing.T) {
	h, _ := newHub(t)
	id1 := h.addAPIKeyAcct(t, account.ProviderCodex, "a@x.com")
	id2 := h.addAPIKeyAcct(t, account.ProviderCodex, "b@x.com")

	res, err := h.WakeupVerifyBatch(account.ProviderCodex, []string{id1, id2})
	if err != nil {
		t.Fatalf("WakeupVerifyBatch: %v", err)
	}
	if res.Total != 2 || res.PassCount != 2 || res.FailCount != 0 {
		t.Fatalf("aggregate wrong: %+v", res)
	}

	state, err := h.WakeupVerificationState(account.ProviderCodex)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if len(state) != 2 {
		t.Fatalf("expected 2 state items, got %d", len(state))
	}

	hist, err := h.WakeupVerificationHistory(account.ProviderCodex)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(hist) != 1 || hist[0].BatchID != res.BatchID {
		t.Fatalf("history wrong: %+v", hist)
	}
}

func TestHub_WakeupVerifyBatch_UnknownProvider(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.WakeupVerifyBatch(account.Provider("nope"), []string{"x"}); err == nil {
		t.Fatal("unknown provider should error")
	}
}

func TestHub_WakeupTestOne(t *testing.T) {
	h, _ := newHub(t)
	id := h.addAPIKeyAcct(t, account.ProviderCodex, "solo@x.com")

	r, err := h.WakeupTestOne(id)
	if err != nil {
		t.Fatalf("WakeupTestOne: %v", err)
	}
	if !r.Ok || r.Email != "solo@x.com" {
		t.Fatalf("single test should pass: %+v", r)
	}
}

func TestHub_WakeupTestOne_UnknownID(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.WakeupTestOne("ghost"); err == nil {
		t.Fatal("unknown id should error")
	}
}

func TestHub_ClearWakeupVerificationHistory(t *testing.T) {
	h, _ := newHub(t)
	id := h.addAPIKeyAcct(t, account.ProviderCodex, "a@x.com")
	r1, _ := h.WakeupVerifyBatch(account.ProviderCodex, []string{id})
	_, _ = h.WakeupVerifyBatch(account.ProviderCodex, []string{id})

	n, err := h.ClearWakeupVerificationHistory(account.ProviderCodex, []string{r1.BatchID})
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 deleted, got %d", n)
	}
	hist, _ := h.WakeupVerificationHistory(account.ProviderCodex)
	if len(hist) != 1 {
		t.Fatalf("expected 1 batch remaining, got %d", len(hist))
	}
}

// 保活验证按 provider 隔离:codex 的验证不落进 antigravity 的历史。
func TestHub_WakeupVerify_ProviderIsolated(t *testing.T) {
	h, _ := newHub(t)
	id := h.addAPIKeyAcct(t, account.ProviderCodex, "a@x.com")
	if _, err := h.WakeupVerifyBatch(account.ProviderCodex, []string{id}); err != nil {
		t.Fatalf("verify codex: %v", err)
	}
	agHist, _ := h.WakeupVerificationHistory(account.ProviderAntigravity)
	if len(agHist) != 0 {
		t.Fatalf("antigravity history should be empty, got %d", len(agHist))
	}
}

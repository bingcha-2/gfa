package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/account"
)

// 安全不变式:网关只看得到 PoolEnabled 的自有号。
func TestStore_ListOnlyOwnPoolAccounts(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "in@y.com", AuthKind: account.AuthOAuth,
		RefreshToken: "rt", AccessToken: "at", AccountID: "acc1", PlanType: "pro", PoolEnabled: true})
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "out@y.com", RefreshToken: "rt2", PoolEnabled: false})

	st := NewStore(acc, account.ProviderCodex)
	auths, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(auths) != 1 {
		t.Fatalf("expected 1 pool auth, got %d", len(auths))
	}
	a := auths[0]
	if a.Provider != "codex" || a.Metadata["refresh_token"] != "rt" || a.Attributes["plan_type"] != "pro" {
		t.Fatalf("auth mapping wrong: %+v", a)
	}
}

// 反代网关只喂 codex:antigravity 进池号不应出现在 codex auth store 里
//(antigravity 接管走 IDE 注入,见 internal/local/antigravityinject)。
func TestStore_CodexScoped_ExcludesAntigravity(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "c@y.com", AuthKind: account.AuthOAuth, RefreshToken: "rc", PoolEnabled: true})
	_ = acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "a@y.com", AuthKind: account.AuthOAuth, RefreshToken: "ra", PoolEnabled: true})

	st := NewStore(acc, account.ProviderCodex)
	auths, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(auths) != 1 || auths[0].Provider != "codex" {
		t.Fatalf("expected only codex auth, got %+v", auths)
	}
}

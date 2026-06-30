package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
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

// 共享网关:一个 Store 同时喂 codex + antigravity 的进池自有号,
// 每个 auth 仍带自己的 Provider(执行器据此路由),远程租号永不在内。
func TestSharedStore_ListsAllProvidersPoolAccounts(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "c@y.com", AuthKind: account.AuthOAuth, RefreshToken: "rc", PoolEnabled: true})
	_ = acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "a@y.com", AuthKind: account.AuthOAuth, RefreshToken: "ra", PoolEnabled: true})
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "off@y.com", PoolEnabled: false})

	st := NewSharedStore(acc)
	auths, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(auths) != 2 {
		t.Fatalf("expected 2 cross-provider auths, got %d", len(auths))
	}
	prov := map[string]bool{}
	for _, a := range auths {
		prov[a.Provider] = true
	}
	if !prov["codex"] || !prov["antigravity"] {
		t.Fatalf("expected both providers in shared store, got %v", prov)
	}
}

func TestSelector_PrefersPriority(t *testing.T) {
	a1 := &coreauth.Auth{ID: "1", Attributes: map[string]string{"priority": "0"}}
	a2 := &coreauth.Auth{ID: "2", Attributes: map[string]string{"priority": "1"}}
	got, err := Selector{}.Pick(context.Background(), "codex", "gpt-5", cliproxyexecutor.Options{}, []*coreauth.Auth{a1, a2})
	if err != nil || got.ID != "2" {
		t.Fatalf("expected priority a2, got %+v err=%v", got, err)
	}
}

func TestSelector_EmptyErrors(t *testing.T) {
	if _, err := (Selector{}).Pick(context.Background(), "codex", "m", cliproxyexecutor.Options{}, nil); err == nil {
		t.Fatal("expected error on empty auths")
	}
}

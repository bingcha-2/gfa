package manager

import (
	"context"
	"errors"
	"testing"

	"bcai-wails/internal/local/account"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

type fakeReloader struct{ n int }

func (f *fakeReloader) Reload() error { f.n++; return nil }

func newMgr(t *testing.T) (*Manager, *account.Store, *fakeReloader) {
	t.Helper()
	acc, err := account.OpenStore(t.TempDir() + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { acc.Close() })
	fr := &fakeReloader{}
	return New(acc, fr), acc, fr
}

func TestListAccounts_View(t *testing.T) {
	m, acc, _ := newMgr(t)
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "a@x.com", AuthKind: account.AuthOAuth,
		PlanType: "pro", PoolEnabled: true, HourlyPercent: 30, Tags: []string{"主力"}})
	views, err := m.ListAccounts(account.ProviderCodex)
	if err != nil || len(views) != 1 {
		t.Fatalf("list: %v len=%d", err, len(views))
	}
	v := views[0]
	if v.Email != "a@x.com" || v.PlanType != "pro" || !v.PoolEnabled || v.HourlyPercent != 30 || v.AuthKind != "oauth" || len(v.Tags) != 1 {
		t.Fatalf("view wrong: %+v", v)
	}
}

func TestSetPriority_ClearsOthers(t *testing.T) {
	m, acc, fr := newMgr(t)
	a1 := &account.Account{Provider: account.ProviderCodex, Email: "1@x", Priority: true, PoolEnabled: true}
	a2 := &account.Account{Provider: account.ProviderCodex, Email: "2@x", PoolEnabled: true}
	_ = acc.Add(a1)
	_ = acc.Add(a2)
	if err := m.SetPriority(account.ProviderCodex, a2.ID); err != nil {
		t.Fatalf("SetPriority: %v", err)
	}
	g1, _ := acc.Get(a1.ID)
	g2, _ := acc.Get(a2.ID)
	if g1.Priority || !g2.Priority {
		t.Fatalf("priority not exclusive: a1=%v a2=%v", g1.Priority, g2.Priority)
	}
	if fr.n == 0 {
		t.Fatal("expected gateway reload after priority change")
	}
}

func TestSetPriority_NotFound(t *testing.T) {
	m, _, _ := newMgr(t)
	if err := m.SetPriority(account.ProviderCodex, "nope"); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestSetPoolEnabled_Reloads(t *testing.T) {
	m, acc, fr := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "p@x", PoolEnabled: true}
	_ = acc.Add(a)
	if err := m.SetPoolEnabled(a.ID, false); err != nil {
		t.Fatalf("SetPoolEnabled: %v", err)
	}
	got, _ := acc.Get(a.ID)
	if got.PoolEnabled {
		t.Fatal("expected pool disabled")
	}
	if fr.n == 0 {
		t.Fatal("expected reload")
	}
}

func TestLogin_AsyncSavesAndReturnsView(t *testing.T) {
	m, acc, fr := newMgr(t)
	m.loginFn = func(ctx context.Context, cfg *config.Config) (*account.Account, error) {
		return &account.Account{Provider: account.ProviderCodex, Email: "new@x.com", AuthKind: account.AuthOAuth, PoolEnabled: true}, nil
	}
	id := m.StartCodexLogin()
	v, err := m.WaitCodexLogin(id)
	if err != nil {
		t.Fatalf("wait: %v", err)
	}
	if v.Email != "new@x.com" {
		t.Fatalf("view email wrong: %+v", v)
	}
	list, _ := acc.List(account.ProviderCodex)
	if len(list) != 1 {
		t.Fatalf("expected account saved, got %d", len(list))
	}
	if fr.n == 0 {
		t.Fatal("expected reload after login")
	}
}

func TestLogin_Error(t *testing.T) {
	m, _, _ := newMgr(t)
	m.loginFn = func(ctx context.Context, cfg *config.Config) (*account.Account, error) {
		return nil, errors.New("oauth failed")
	}
	id := m.StartCodexLogin()
	if _, err := m.WaitCodexLogin(id); err == nil {
		t.Fatal("expected login error propagated")
	}
}

func TestWaitUnknownSession(t *testing.T) {
	m, _, _ := newMgr(t)
	if _, err := m.WaitCodexLogin("bogus"); err == nil {
		t.Fatal("expected unknown session error")
	}
}

func TestExportImport_RoundTripAndDedup(t *testing.T) {
	src, acc, _ := newMgr(t)
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "a@x.com", AuthKind: account.AuthOAuth, RefreshToken: "rt-a", PlanType: "pro", Tags: []string{"主力"}})
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "b@x.com", AuthKind: account.AuthAPIKey, APIKey: "sk-b"})

	dump, err := src.Export(account.ProviderCodex, nil)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// 导入到新 store
	dst, dacc, _ := newMgr(t)
	added, err := dst.ImportJSON(account.ProviderCodex, dump)
	if err != nil || added != 2 {
		t.Fatalf("ImportJSON added=%d err=%v", added, err)
	}
	got, _ := dacc.List(account.ProviderCodex)
	if len(got) != 2 {
		t.Fatalf("expected 2 imported, got %d", len(got))
	}
	// 字段保真 + AuthKind 区分
	var oauth, apikey *account.Account
	for _, a := range got {
		if a.Email == "a@x.com" {
			oauth = a
		}
		if a.Email == "b@x.com" {
			apikey = a
		}
	}
	if oauth == nil || oauth.RefreshToken != "rt-a" || oauth.PlanType != "pro" || oauth.AuthKind != account.AuthOAuth {
		t.Fatalf("oauth import wrong: %+v", oauth)
	}
	if apikey == nil || apikey.APIKey != "sk-b" || apikey.AuthKind != account.AuthAPIKey {
		t.Fatalf("apikey import wrong: %+v", apikey)
	}

	// 再次导入同样数据 → 全部去重,added=0
	again, err := dst.ImportJSON(account.ProviderCodex, dump)
	if err != nil || again != 0 {
		t.Fatalf("dedup failed: added=%d err=%v", again, err)
	}
}

func TestDeleteAccounts_Batch(t *testing.T) {
	m, acc, fr := newMgr(t)
	a1 := &account.Account{Provider: account.ProviderCodex, Email: "1@x"}
	a2 := &account.Account{Provider: account.ProviderCodex, Email: "2@x"}
	a3 := &account.Account{Provider: account.ProviderCodex, Email: "3@x"}
	_ = acc.Add(a1)
	_ = acc.Add(a2)
	_ = acc.Add(a3)
	if err := m.DeleteAccounts([]string{a1.ID, a3.ID}); err != nil {
		t.Fatalf("DeleteAccounts: %v", err)
	}
	got, _ := acc.List(account.ProviderCodex)
	if len(got) != 1 || got[0].Email != "2@x" {
		t.Fatalf("batch delete wrong: %+v", got)
	}
	if fr.n == 0 {
		t.Fatal("expected reload after batch delete")
	}
}

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

package manager

import (
	"context"
	"errors"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codexauth"
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
	return New(acc, fr, account.ProviderCodex, codexauth.Login), acc, fr
}

func TestListAccounts_View(t *testing.T) {
	m, acc, _ := newMgr(t)
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "a@x.com", AuthKind: account.AuthOAuth,
		PlanType: "pro", PoolEnabled: true, HourlyPercent: 30, Tags: []string{"主力"}})
	views, err := m.ListAccounts()
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
	if err := m.SetPriority(a2.ID); err != nil {
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
	if err := m.SetPriority("nope"); err == nil {
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
	id := m.StartLogin()
	v, err := m.WaitLogin(id)
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
	id := m.StartLogin()
	if _, err := m.WaitLogin(id); err == nil {
		t.Fatal("expected login error propagated")
	}
}

func TestWaitUnknownSession(t *testing.T) {
	m, _, _ := newMgr(t)
	if _, err := m.WaitLogin("bogus"); err == nil {
		t.Fatal("expected unknown session error")
	}
}

func TestExportImport_RoundTripAndDedup(t *testing.T) {
	src, acc, _ := newMgr(t)
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "a@x.com", AuthKind: account.AuthOAuth, RefreshToken: "rt-a", PlanType: "pro", Tags: []string{"主力"}})
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "b@x.com", AuthKind: account.AuthAPIKey, APIKey: "sk-b"})

	dump, err := src.Export(nil)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// 导入到新 store
	dst, dacc, _ := newMgr(t)
	added, err := dst.ImportJSON(dump)
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
	again, err := dst.ImportJSON(dump)
	if err != nil || again != 0 {
		t.Fatalf("dedup failed: added=%d err=%v", again, err)
	}
}

func TestAddByToken_OAuth(t *testing.T) {
	m, acc, fr := newMgr(t)
	v, err := m.AddByToken("rt-1", "at-1", "me@x.com")
	if err != nil {
		t.Fatalf("AddByToken: %v", err)
	}
	if v.Email != "me@x.com" || v.AuthKind != "oauth" || !v.PoolEnabled {
		t.Fatalf("view wrong: %+v", v)
	}
	got, _ := acc.Get(v.ID)
	if got.RefreshToken != "rt-1" || got.AccessToken != "at-1" || got.AuthKind != account.AuthOAuth || got.Provider != account.ProviderCodex {
		t.Fatalf("account wrong: %+v", got)
	}
	if fr.n == 0 {
		t.Fatal("expected reload after AddByToken")
	}
}

func TestAddByAPIKey(t *testing.T) {
	m, acc, fr := newMgr(t)
	v, err := m.AddByAPIKey("sk-xyz", "https://api.example.com", "k@x.com")
	if err != nil {
		t.Fatalf("AddByAPIKey: %v", err)
	}
	if v.AuthKind != "apikey" {
		t.Fatalf("view authKind wrong: %+v", v)
	}
	got, _ := acc.Get(v.ID)
	if got.APIKey != "sk-xyz" || got.APIBaseURL != "https://api.example.com" || got.AuthKind != account.AuthAPIKey {
		t.Fatalf("account wrong: %+v", got)
	}
	if fr.n == 0 {
		t.Fatal("expected reload after AddByAPIKey")
	}
}

func TestRename_SetNote_SetTags(t *testing.T) {
	m, acc, fr := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "e@x", PoolEnabled: true}
	_ = acc.Add(a)
	if err := m.Rename(a.ID, "新名"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := m.SetNote(a.ID, "备注内容"); err != nil {
		t.Fatalf("SetNote: %v", err)
	}
	if err := m.SetTags(a.ID, []string{"x", "y"}); err != nil {
		t.Fatalf("SetTags: %v", err)
	}
	got, _ := acc.Get(a.ID)
	if got.Name != "新名" || got.Note != "备注内容" || len(got.Tags) != 2 {
		t.Fatalf("edit round-trip wrong: %+v", got)
	}
	if fr.n == 0 {
		t.Fatal("expected reload after edits")
	}
	// AccountView 带上 name
	views, _ := m.ListAccounts()
	if len(views) != 1 || views[0].Name != "新名" {
		t.Fatalf("view name wrong: %+v", views)
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

// Current 返回当前(优先级)号;无优先级时回退第一个;空池返回 nil。
func TestManager_Current(t *testing.T) {
	m, acc, _ := newMgr(t)
	if cur, err := m.Current(); err != nil || cur != nil {
		t.Fatalf("empty pool should yield nil current: %+v %v", cur, err)
	}
	a := &account.Account{Provider: account.ProviderCodex, Email: "a@x.com", PoolEnabled: true}
	b := &account.Account{Provider: account.ProviderCodex, Email: "b@x.com", PoolEnabled: true, Priority: true}
	_ = acc.Add(a)
	_ = acc.Add(b)
	cur, err := m.Current()
	if err != nil || cur == nil || cur.ID != b.ID {
		t.Fatalf("expected priority account as current: %+v %v", cur, err)
	}
}

// SetCurrent 等价于把某号设为优先(并清其它),Current 随之指向它。
func TestManager_SetCurrent(t *testing.T) {
	m, acc, fr := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "a@x.com", PoolEnabled: true, Priority: true}
	b := &account.Account{Provider: account.ProviderCodex, Email: "b@x.com", PoolEnabled: true}
	_ = acc.Add(a)
	_ = acc.Add(b)
	before := fr.n
	if err := m.SetCurrent(b.ID); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}
	cur, _ := m.Current()
	if cur == nil || cur.ID != b.ID {
		t.Fatalf("current should be b after SetCurrent: %+v", cur)
	}
	ga, _ := acc.Get(a.ID)
	if ga.Priority {
		t.Fatal("a should no longer be priority")
	}
	if fr.n == before {
		t.Fatal("expected gateway reload after SetCurrent")
	}
}

// Reorder 委托 store 持久化排序,ListAccounts 随之换序,并触发网关 reload。
func TestManager_Reorder(t *testing.T) {
	m, acc, fr := newMgr(t)
	a := &account.Account{Provider: account.ProviderCodex, Email: "a@x.com", PoolEnabled: true}
	b := &account.Account{Provider: account.ProviderCodex, Email: "b@x.com", PoolEnabled: true}
	_ = acc.Add(a)
	_ = acc.Add(b)
	before := fr.n
	if err := m.Reorder([]string{b.ID, a.ID}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	views, _ := m.ListAccounts()
	if len(views) != 2 || views[0].ID != b.ID || views[1].ID != a.ID {
		t.Fatalf("reordered views wrong: %+v", views)
	}
	if fr.n == before {
		t.Fatal("expected reload after Reorder")
	}
}

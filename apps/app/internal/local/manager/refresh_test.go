package manager

import (
	"errors"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/quota"
)

// fakeRefresher 注入到 manager,记录调用并返回可控结果。
type fakeRefresher struct {
	refreshTokenCalls int
	tokenExpired      bool
	fetchErr          error
	res               quota.Result
}

func (f *fakeRefresher) TokenExpired(a *account.Account) bool { return f.tokenExpired }
func (f *fakeRefresher) RefreshToken(a *account.Account) error {
	f.refreshTokenCalls++
	f.tokenExpired = false
	a.AccessToken = "refreshed-access"
	return nil
}
func (f *fakeRefresher) FetchQuota(a *account.Account) (quota.Result, error) {
	if f.fetchErr != nil {
		return quota.Result{}, f.fetchErr
	}
	return f.res, nil
}

func newMgrWithRefresher(t *testing.T, r Refresher) (*Manager, *account.Store) {
	t.Helper()
	acc, err := account.OpenStore(t.TempDir() + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { acc.Close() })
	m := New(acc, &fakeReloader{}, account.ProviderCodex, nil)
	m.SetRefresher(r)
	return m, acc
}

func TestRefreshQuota_PersistsResult(t *testing.T) {
	r := &fakeRefresher{res: quota.Result{HourlyPercent: 65, WeeklyPercent: 40, HourlyResetAt: 111, WeeklyResetAt: 222, HourlyKnown: true, WeeklyKnown: true, PlanType: "pro"}}
	m, acc := newMgrWithRefresher(t, r)
	a := &account.Account{Provider: account.ProviderCodex, Email: "q@x", AuthKind: account.AuthOAuth, PoolEnabled: true, QuotaStatus: account.QuotaError}
	_ = acc.Add(a)

	if err := m.RefreshQuota(a.ID); err != nil {
		t.Fatalf("RefreshQuota: %v", err)
	}
	got, _ := acc.Get(a.ID)
	if got.HourlyPercent != 65 || got.WeeklyPercent != 40 || got.HourlyResetAt != 111 || got.WeeklyResetAt != 222 {
		t.Fatalf("quota not persisted: %+v", got)
	}
	if got.QuotaStatus != account.QuotaOK {
		t.Fatalf("status should become ok, got %q", got.QuotaStatus)
	}
	if got.PlanType != "pro" {
		t.Fatalf("plan should sync, got %q", got.PlanType)
	}
}

func TestRefreshQuota_RefreshesExpiredTokenFirst(t *testing.T) {
	r := &fakeRefresher{tokenExpired: true, res: quota.Result{HourlyPercent: 90, WeeklyPercent: 90, HourlyKnown: true, WeeklyKnown: true}}
	m, acc := newMgrWithRefresher(t, r)
	a := &account.Account{Provider: account.ProviderCodex, Email: "e@x", AuthKind: account.AuthOAuth, RefreshToken: "rt", PoolEnabled: true}
	_ = acc.Add(a)

	if err := m.RefreshQuota(a.ID); err != nil {
		t.Fatalf("RefreshQuota: %v", err)
	}
	if r.refreshTokenCalls != 1 {
		t.Fatalf("expected 1 token refresh, got %d", r.refreshTokenCalls)
	}
	got, _ := acc.Get(a.ID)
	if got.AccessToken != "refreshed-access" {
		t.Fatalf("refreshed token not persisted: %+v", got)
	}
}

func TestRefreshQuota_FetchErrorMarksStatus(t *testing.T) {
	r := &fakeRefresher{fetchErr: errors.New("API 返回错误 401")}
	m, acc := newMgrWithRefresher(t, r)
	a := &account.Account{Provider: account.ProviderCodex, Email: "f@x", AuthKind: account.AuthOAuth, PoolEnabled: true, QuotaStatus: account.QuotaOK}
	_ = acc.Add(a)

	if err := m.RefreshQuota(a.ID); err == nil {
		t.Fatal("expected error propagated")
	}
	got, _ := acc.Get(a.ID)
	if got.QuotaStatus != account.QuotaError || got.QuotaReason == "" {
		t.Fatalf("status should be error with reason: %+v", got)
	}
}

func TestRefreshQuota_APIKeyAccountSkipped(t *testing.T) {
	r := &fakeRefresher{res: quota.Result{HourlyPercent: 10, HourlyKnown: true}}
	m, acc := newMgrWithRefresher(t, r)
	a := &account.Account{Provider: account.ProviderCodex, Email: "k@x", AuthKind: account.AuthAPIKey, APIKey: "sk", PoolEnabled: true}
	_ = acc.Add(a)
	// API Key 号不支持刷新配额 -> 返回错误,不改额度。
	if err := m.RefreshQuota(a.ID); err == nil {
		t.Fatal("expected api-key unsupported error")
	}
}

func TestRefreshAllQuotas_OnlyPoolEnabled(t *testing.T) {
	r := &fakeRefresher{res: quota.Result{HourlyPercent: 50, WeeklyPercent: 50, HourlyKnown: true, WeeklyKnown: true}}
	m, acc := newMgrWithRefresher(t, r)
	in := &account.Account{Provider: account.ProviderCodex, Email: "in@x", AuthKind: account.AuthOAuth, PoolEnabled: true}
	out := &account.Account{Provider: account.ProviderCodex, Email: "out@x", AuthKind: account.AuthOAuth, PoolEnabled: false}
	_ = acc.Add(in)
	_ = acc.Add(out)

	n, err := m.RefreshAllQuotas()
	if err != nil {
		t.Fatalf("RefreshAllQuotas: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 refreshed (pool only), got %d", n)
	}
	gotIn, _ := acc.Get(in.ID)
	gotOut, _ := acc.Get(out.ID)
	if gotIn.HourlyPercent != 50 {
		t.Fatalf("pool account should be refreshed: %+v", gotIn)
	}
	if gotOut.HourlyPercent != 0 {
		t.Fatalf("non-pool account should be untouched: %+v", gotOut)
	}
}

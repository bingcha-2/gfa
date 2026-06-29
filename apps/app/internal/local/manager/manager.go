// Package manager 编排本地自有号:串起账号 store、登录、网关重载。
// 它是 Wails App 方法委托的目标,App 层只做薄绑定。
package manager

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codexauth"
	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// Reloader 抽象「让网关重载自有号」,便于测试(gateway.Gateway 实现 Reload)。
type Reloader interface{ Reload() error }

// AccountView 是给前端的账号视图(不含原始 token)。
type AccountView struct {
	ID            string   `json:"id"`
	Email         string   `json:"email"`
	Provider      string   `json:"provider"`
	AuthKind      string   `json:"authKind"`
	PlanType      string   `json:"planType"`
	QuotaStatus   string   `json:"quotaStatus"`
	Tags          []string `json:"tags"`
	PoolEnabled   bool     `json:"poolEnabled"`
	Priority      bool     `json:"priority"`
	HourlyPercent int      `json:"hourlyPercent"`
	WeeklyPercent int      `json:"weeklyPercent"`
	HourlyResetAt int64    `json:"hourlyResetAt"`
	WeeklyResetAt int64    `json:"weeklyResetAt"`
	LastUsedAt    int64    `json:"lastUsedAt"`
}

func toView(a *account.Account) AccountView {
	return AccountView{
		ID: a.ID, Email: a.Email, Provider: string(a.Provider), AuthKind: string(a.AuthKind),
		PlanType: a.PlanType, QuotaStatus: string(a.QuotaStatus), Tags: a.Tags,
		PoolEnabled: a.PoolEnabled, Priority: a.Priority,
		HourlyPercent: a.HourlyPercent, WeeklyPercent: a.WeeklyPercent,
		HourlyResetAt: a.HourlyResetAt, WeeklyResetAt: a.WeeklyResetAt, LastUsedAt: a.LastUsedAt,
	}
}

type loginState struct {
	done chan struct{}
	view AccountView
	err  error
}

type Manager struct {
	acc     *account.Store
	gw      Reloader // nil-able(测试或网关未启动)
	loginFn func(context.Context, *config.Config) (*account.Account, error)

	mu     sync.Mutex
	logins map[string]*loginState
}

func New(acc *account.Store, gw Reloader) *Manager {
	return &Manager{acc: acc, gw: gw, loginFn: codexauth.Login, logins: map[string]*loginState{}}
}

func (m *Manager) reload() {
	if m.gw != nil {
		_ = m.gw.Reload()
	}
}

func (m *Manager) ListAccounts(provider account.Provider) ([]AccountView, error) {
	list, err := m.acc.List(provider)
	if err != nil {
		return nil, err
	}
	out := make([]AccountView, 0, len(list))
	for _, a := range list {
		out = append(out, toView(a))
	}
	return out, nil
}

func (m *Manager) SetPoolEnabled(id string, enabled bool) error {
	a, err := m.acc.Get(id)
	if err != nil {
		return err
	}
	a.PoolEnabled = enabled
	if err := m.acc.Update(a); err != nil {
		return err
	}
	m.reload()
	return nil
}

// SetPriority 把某号设为优先出口,并清除同 provider 其它号的优先标记。
func (m *Manager) SetPriority(provider account.Provider, id string) error {
	list, err := m.acc.List(provider)
	if err != nil {
		return err
	}
	found := false
	for _, a := range list {
		want := a.ID == id
		if a.Priority != want {
			a.Priority = want
			if err := m.acc.Update(a); err != nil {
				return err
			}
		}
		if want {
			found = true
		}
	}
	if !found {
		return errors.New("manager: account not found")
	}
	m.reload()
	return nil
}

func (m *Manager) DeleteAccount(id string) error {
	if err := m.acc.Delete(id); err != nil {
		return err
	}
	m.reload()
	return nil
}

// StartCodexLogin 异步发起 OAuth(SDK 会开浏览器并阻塞等回调);返回 loginId。
func (m *Manager) StartCodexLogin() string {
	id := uuid.NewString()
	st := &loginState{done: make(chan struct{})}
	m.mu.Lock()
	m.logins[id] = st
	m.mu.Unlock()
	go func() {
		defer close(st.done)
		acc, err := m.loginFn(context.Background(), nil)
		if err != nil {
			st.err = err
			return
		}
		if acc == nil {
			st.err = errors.New("manager: login returned nil account")
			return
		}
		if err := m.acc.Add(acc); err != nil {
			st.err = err
			return
		}
		m.reload()
		st.view = toView(acc)
	}()
	return id
}

// ExportRecord 是导出/导入的账号载荷(含 token,因为是用户自己的号,用于备份/迁移)。
type ExportRecord struct {
	Email        string   `json:"email"`
	AuthKind     string   `json:"authKind"`
	IDToken      string   `json:"idToken,omitempty"`
	AccessToken  string   `json:"accessToken,omitempty"`
	RefreshToken string   `json:"refreshToken,omitempty"`
	APIKey       string   `json:"apiKey,omitempty"`
	APIBaseURL   string   `json:"apiBaseUrl,omitempty"`
	AccountID    string   `json:"accountId,omitempty"`
	PlanType     string   `json:"planType,omitempty"`
	Note         string   `json:"note,omitempty"`
	Tags         []string `json:"tags,omitempty"`
}

// Export 把指定账号(ids 为空=全部)导出为 JSON。
func (m *Manager) Export(provider account.Provider, ids []string) (string, error) {
	list, err := m.acc.List(provider)
	if err != nil {
		return "", err
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	recs := make([]ExportRecord, 0, len(list))
	for _, a := range list {
		if len(ids) > 0 && !want[a.ID] {
			continue
		}
		recs = append(recs, ExportRecord{
			Email: a.Email, AuthKind: string(a.AuthKind), IDToken: a.IDToken, AccessToken: a.AccessToken,
			RefreshToken: a.RefreshToken, APIKey: a.APIKey, APIBaseURL: a.APIBaseURL, AccountID: a.AccountID,
			PlanType: a.PlanType, Note: a.Note, Tags: a.Tags,
		})
	}
	data, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ImportJSON 从 JSON 导入账号,按 email 去重(已存在则跳过)。返回新增数量。
func (m *Manager) ImportJSON(provider account.Provider, jsonStr string) (int, error) {
	var recs []ExportRecord
	if err := json.Unmarshal([]byte(jsonStr), &recs); err != nil {
		return 0, err
	}
	existing, err := m.acc.List(provider)
	if err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	for _, a := range existing {
		if a.Email != "" {
			seen[a.Email] = true
		}
	}
	added := 0
	for _, r := range recs {
		if r.Email != "" && seen[r.Email] {
			continue
		}
		kind := account.AuthKind(r.AuthKind)
		if kind != account.AuthAPIKey {
			kind = account.AuthOAuth
		}
		if err := m.acc.Add(&account.Account{
			Provider: provider, Email: r.Email, AuthKind: kind, IDToken: r.IDToken, AccessToken: r.AccessToken,
			RefreshToken: r.RefreshToken, APIKey: r.APIKey, APIBaseURL: r.APIBaseURL, AccountID: r.AccountID,
			PlanType: r.PlanType, Note: r.Note, Tags: r.Tags, PoolEnabled: true, QuotaStatus: account.QuotaOK,
		}); err != nil {
			return added, err
		}
		if r.Email != "" {
			seen[r.Email] = true
		}
		added++
	}
	if added > 0 {
		m.reload()
	}
	return added, nil
}

// DeleteAccounts 批量删除。
func (m *Manager) DeleteAccounts(ids []string) error {
	for _, id := range ids {
		if err := m.acc.Delete(id); err != nil {
			return err
		}
	}
	if len(ids) > 0 {
		m.reload()
	}
	return nil
}

// WaitCodexLogin 阻塞直至对应登录完成,返回新号视图。
func (m *Manager) WaitCodexLogin(id string) (AccountView, error) {
	m.mu.Lock()
	st := m.logins[id]
	m.mu.Unlock()
	if st == nil {
		return AccountView{}, errors.New("manager: unknown login session")
	}
	<-st.done
	if st.err != nil {
		return AccountView{}, st.err
	}
	return st.view, nil
}

// Package manager 编排本地自有号:串起账号 store、登录、网关重载。
// 它是 Wails App 方法委托的目标,App 层只做薄绑定。
package manager

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"bcai-wails/internal/local/account"
	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// LoginFunc 是某 provider 的 OAuth 登录(codexauth.Login / antigravityauth.Login)。
type LoginFunc func(ctx context.Context, cfg *config.Config) (*account.Account, error)

// Reloader 抽象「让网关重载自有号」,便于测试(gateway.Gateway 实现 Reload)。
type Reloader interface{ Reload() error }

// AccountView 是给前端的账号视图(不含原始 token)。
type AccountView struct {
	ID            string   `json:"id"`
	Email         string   `json:"email"`
	Name          string   `json:"name"`
	Provider      string   `json:"provider"`
	AuthKind      string   `json:"authKind"`
	Note          string   `json:"note"`
	PlanType      string   `json:"planType"`
	QuotaStatus   string   `json:"quotaStatus"`
	Tags          []string `json:"tags"`
	PoolEnabled   bool     `json:"poolEnabled"`
	Priority      bool     `json:"priority"`
	// ServiceTier 是按号服务档(codex 专属):""(继承/标准)| "fast"(快速=上游 priority)。
	ServiceTier   string   `json:"serviceTier"`
	HourlyPercent int      `json:"hourlyPercent"`
	WeeklyPercent int      `json:"weeklyPercent"`
	HourlyResetAt int64    `json:"hourlyResetAt"`
	WeeklyResetAt int64    `json:"weeklyResetAt"`
	LastUsedAt    int64    `json:"lastUsedAt"`
}

// ToView 把一个 account.Account 适配成只读视图(供 hub 显式当前号 get 复用)。
func ToView(a *account.Account) AccountView { return toView(a) }

func toView(a *account.Account) AccountView {
	return AccountView{
		ID: a.ID, Email: a.Email, Name: a.Name, Provider: string(a.Provider), AuthKind: string(a.AuthKind),
		Note: a.Note, PlanType: a.PlanType, QuotaStatus: string(a.QuotaStatus), Tags: a.Tags,
		PoolEnabled: a.PoolEnabled, Priority: a.Priority, ServiceTier: a.ServiceTier,
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
	acc       *account.Store
	gw        Reloader // nil-able(测试或网关未启动)
	provider  account.Provider
	loginFn   LoginFunc
	refresher Refresher // nil-able(按号额度刷新/续约;hub 注入)

	mu     sync.Mutex
	logins map[string]*loginState
}

func New(acc *account.Store, gw Reloader, provider account.Provider, loginFn LoginFunc) *Manager {
	return &Manager{acc: acc, gw: gw, provider: provider, loginFn: loginFn, logins: map[string]*loginState{}}
}

// Provider 返回此 manager 管理的 provider。
func (m *Manager) Provider() account.Provider { return m.provider }

func (m *Manager) reload() {
	if m.gw != nil {
		_ = m.gw.Reload()
	}
}

// ReloadGateway 让网关重载自有号(导入/同步加号后由 hub 调用)。
func (m *Manager) ReloadGateway() { m.reload() }

func (m *Manager) ListAccounts() ([]AccountView, error) {
	list, err := m.acc.List(m.provider)
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
func (m *Manager) SetPriority(id string) error {
	list, err := m.acc.List(m.provider)
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

// Current 返回当前(优先级)号:优先级号;无优先级则第一个进池号;空池返回 (nil,nil)。
// 对齐 cockpit accounts.current(resolve_current_account_id)。
func (m *Manager) Current() (*account.Account, error) {
	list, err := m.acc.ListPoolEnabled(m.provider)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	for _, a := range list {
		if a.Priority {
			return a, nil
		}
	}
	return list[0], nil
}

// SetCurrent 显式设当前号 = 把某号设为优先出口(并清同 provider 其它号优先标记)。
// 对齐 cockpit accounts.setCurrent。
func (m *Manager) SetCurrent(id string) error { return m.SetPriority(id) }

// Reorder 按 ids 顺序持久化本 provider 账号排序(未列出的排到末尾),并热刷网关。
// 对齐 cockpit accounts.reorder。
func (m *Manager) Reorder(ids []string) error {
	if err := m.acc.Reorder(m.provider, ids); err != nil {
		return err
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

// StartLogin 异步发起 OAuth(SDK 会开浏览器并阻塞等回调);返回 loginId。
func (m *Manager) StartLogin() string {
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

// AddByToken 手动加一个 OAuth 自有号(用户自备 refresh/access token)。
func (m *Manager) AddByToken(refreshToken, accessToken, email string) (AccountView, error) {
	acc := &account.Account{
		Provider: m.provider, Email: email, AuthKind: account.AuthOAuth,
		RefreshToken: refreshToken, AccessToken: accessToken,
		PoolEnabled: true, QuotaStatus: account.QuotaOK,
	}
	if err := m.acc.Add(acc); err != nil {
		return AccountView{}, err
	}
	m.reload()
	return toView(acc), nil
}

// AddByAPIKey 手动加一个自备 API Key 自有号。
func (m *Manager) AddByAPIKey(apiKey, baseURL, email string) (AccountView, error) {
	acc := &account.Account{
		Provider: m.provider, Email: email, AuthKind: account.AuthAPIKey,
		APIKey: apiKey, APIBaseURL: baseURL,
		PoolEnabled: true, QuotaStatus: account.QuotaOK,
	}
	if err := m.acc.Add(acc); err != nil {
		return AccountView{}, err
	}
	m.reload()
	return toView(acc), nil
}

// Rename 改账号显示名(provider 无关,按 id)。
func (m *Manager) Rename(id, name string) error {
	return m.editField(id, func(a *account.Account) { a.Name = name })
}

// SetNote 改账号备注。
func (m *Manager) SetNote(id, note string) error {
	return m.editField(id, func(a *account.Account) { a.Note = note })
}

// SetTags 改账号标签。
func (m *Manager) SetTags(id string, tags []string) error {
	return m.editField(id, func(a *account.Account) { a.Tags = tags })
}

// SetServiceTier 设按号服务档(codex 专属),归一后落库并热刷网关。
//   - "fast"/"priority"/"flex" → "fast"(出口需带 service_tier:"priority");
//   - 空/standard/未知 → ""(继承标准档)。
//
// 对齐 cockpit accounts.updateAppSpeed。egress 侧真正注入 service_tier 的接线见
// authsync 的 TODO(嵌入式 CLIProxyAPI 无逐号请求体注入钩子)。
func (m *Manager) SetServiceTier(id, tier string) error {
	norm := account.NormalizeServiceTier(tier)
	return m.editField(id, func(a *account.Account) { a.ServiceTier = norm })
}

func (m *Manager) editField(id string, mut func(*account.Account)) error {
	a, err := m.acc.Get(id)
	if err != nil {
		return err
	}
	mut(a)
	if err := m.acc.Update(a); err != nil {
		return err
	}
	m.reload()
	return nil
}

// ExportRecord 是导出/导入的账号载荷(含 token,因为是用户自己的号,用于备份/迁移)。
type ExportRecord struct {
	Email        string   `json:"email"`
	Name         string   `json:"name,omitempty"`
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
func (m *Manager) Export(ids []string) (string, error) {
	list, err := m.acc.List(m.provider)
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
			Email: a.Email, Name: a.Name, AuthKind: string(a.AuthKind), IDToken: a.IDToken, AccessToken: a.AccessToken,
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
func (m *Manager) ImportJSON(jsonStr string) (int, error) {
	var recs []ExportRecord
	if err := json.Unmarshal([]byte(jsonStr), &recs); err != nil {
		return 0, err
	}
	existing, err := m.acc.List(m.provider)
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
			Provider: m.provider, Email: r.Email, Name: r.Name, AuthKind: kind, IDToken: r.IDToken, AccessToken: r.AccessToken,
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

// WaitLogin 阻塞直至对应登录完成,返回新号视图。
func (m *Manager) WaitLogin(id string) (AccountView, error) {
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

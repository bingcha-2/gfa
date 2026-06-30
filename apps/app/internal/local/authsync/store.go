// Package authsync 把本地自有号桥接成 CLIProxyAPI 网关的 auth 来源。
//
// 安全不变式(spec §3):本 Store 是网关账号的【唯一入口】,其 List 只读
// account.Store 里 PoolEnabled 的自有号。远程租号(lease)不经过本包任何路径,
// 因此从编译期就无法进入网关。
package authsync

import (
	"context"
	"strconv"
	"time"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// Store 实现 coreauth.Store(v7.2.47:List/Save/Delete),只喂单个 provider 的进池自有号。
type Store struct {
	acc      *account.Store
	provider account.Provider
}

func NewStore(acc *account.Store, p account.Provider) *Store {
	return &Store{acc: acc, provider: p}
}

func (s *Store) List(ctx context.Context) ([]*coreauth.Auth, error) {
	list, err := s.acc.ListPoolEnabled(s.provider)
	if err != nil {
		return nil, err
	}
	out := make([]*coreauth.Auth, 0, len(list))
	for _, a := range list {
		out = append(out, toAuth(a))
	}
	return out, nil
}

func toAuth(a *account.Account) *coreauth.Auth {
	prio := "0"
	if a.Priority {
		prio = "1"
	}
	return &coreauth.Auth{
		ID:       a.ID,
		Provider: string(a.Provider),
		Label:    a.Email,
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			"plan_type":     a.PlanType,
			"auth_kind":     string(a.AuthKind),
			"priority":      prio,
			"remaining_pct": strconv.Itoa(accountRemainingPct(a)), // fair 路由用:剩余额度百分比
		},
		Metadata: map[string]any{
			"access_token":  a.AccessToken,
			"refresh_token": a.RefreshToken,
			"id_token":      a.IDToken,
			"account_id":    a.AccountID,
			"email":         a.Email,
			"project_id":    a.ProjectID, // antigravity 需要
		},
		CreatedAt: time.UnixMilli(a.CreatedAt).UTC(),
		UpdatedAt: time.UnixMilli(a.UpdatedAt).UTC(),
	}
}

// accountRemainingPct 把账号的「已用百分比」(小时/周里更紧的那个)折成剩余额度
// 百分比(0-100),对齐 cockpit quota = min(hourly_remaining, weekly_remaining)。
func accountRemainingPct(a *account.Account) int {
	used := a.HourlyPercent
	if a.WeeklyPercent > used {
		used = a.WeeklyPercent
	}
	rem := 100 - used
	if rem < 0 {
		rem = 0
	}
	if rem > 100 {
		rem = 100
	}
	return rem
}

// Save/Delete 满足接口;不持久化——单一事实源在 account.Store。
func (s *Store) Save(ctx context.Context, a *coreauth.Auth) (string, error) { return a.ID, nil }
func (s *Store) Delete(ctx context.Context, id string) error                { return nil }

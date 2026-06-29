// Package authsync 把本地自有号桥接成 CLIProxyAPI 网关的 auth 来源。
//
// 安全不变式(spec §3):本 Store 是网关账号的【唯一入口】,其 List 只读
// account.Store 里 PoolEnabled 的自有号。远程租号(lease)不经过本包任何路径,
// 因此从编译期就无法进入网关。
package authsync

import (
	"context"
	"time"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// Store 实现 coreauth.Store(v7.2.47:List/Save/Delete)。
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
			"plan_type": a.PlanType,
			"auth_kind": string(a.AuthKind),
			"priority":  prio,
		},
		Metadata: map[string]any{
			"access_token":  a.AccessToken,
			"refresh_token": a.RefreshToken,
			"id_token":      a.IDToken,
			"account_id":    a.AccountID,
			"email":         a.Email,
		},
		CreatedAt: time.UnixMilli(a.CreatedAt).UTC(),
		UpdatedAt: time.UnixMilli(a.UpdatedAt).UTC(),
	}
}

// Save/Delete 满足接口;不持久化——单一事实源在 account.Store。
func (s *Store) Save(ctx context.Context, a *coreauth.Auth) (string, error) { return a.ID, nil }
func (s *Store) Delete(ctx context.Context, id string) error                { return nil }

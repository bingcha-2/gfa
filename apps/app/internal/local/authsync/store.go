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

// accountRemainingPct 取账号「更紧的那个窗口」的剩余额度百分比(0-100),
// 对齐 cockpit quota = min(hourly_remaining, weekly_remaining)。
// 注意:HourlyPercent/WeeklyPercent 本就是「剩余%」(quota.normalizeRemainingPercentage = 100-used),
// 故取 min;旧实现把剩余当已用又用 max,双重反掉,会把流量打到快用尽的号。
func accountRemainingPct(a *account.Account) int {
	rem := -1
	for _, value := range []int{a.HourlyPercent, a.WeeklyPercent} {
		if value >= 0 && (rem < 0 || value < rem) {
			rem = value
		}
	}
	if rem < 0 {
		rem = 0
	}
	if rem > 100 {
		rem = 100
	}
	return rem
}

// Save 把网关 coreauth.Manager 刷新后【轮换】出来的新令牌写回 account.Store。
//
// 为什么必须落这一步:codex OAuth 用「刷新令牌轮换」——每次刷新都会作废旧 refresh_token
// 并发新的。网关的 core auth auto-refresh(15m)刷新后会调本 Save;若这里丢弃(旧实现是
// no-op),GFA 自己的额度/保活刷新就会拿着【已作废的旧 refresh_token】再刷,触发上游
// refresh_token_reused(401)。故网关刷新后必须把新 token 同步回单一事实源 account.Store,
// 两边口径才一致。仅同步 token 三件套(access/refresh/id);codex 过期判定读 access_token
// 的 JWT exp,故同步 access_token 即隐式修正过期视图,无需单独落 Expiry。status/attributes
// 等运行态仍不落盘——account.Store 才是权威。
func (s *Store) Save(ctx context.Context, a *coreauth.Auth) (string, error) {
	if a == nil {
		return "", nil
	}
	if a.ID == "" || a.Metadata == nil {
		return a.ID, nil
	}
	acc, err := s.acc.Get(a.ID)
	if err != nil {
		// 不在 account.Store(临时/已删)——不是要同步的自有号,放行。
		return a.ID, nil
	}
	at, _ := a.Metadata["access_token"].(string)
	rt, _ := a.Metadata["refresh_token"].(string)
	idt, _ := a.Metadata["id_token"].(string)
	changed := false
	if at != "" && at != acc.AccessToken {
		acc.AccessToken = at
		changed = true
	}
	if rt != "" && rt != acc.RefreshToken {
		acc.RefreshToken = rt
		changed = true
	}
	if idt != "" && idt != acc.IDToken {
		acc.IDToken = idt
		changed = true
	}
	if !changed {
		return a.ID, nil
	}
	// 落盘失败不致命:网关内存态本轮仍可用,下轮再试。
	_ = s.acc.Update(acc)
	return a.ID, nil
}

// Delete 满足接口;不持久化——账号增删由 account.Store 权威管理。
func (s *Store) Delete(ctx context.Context, id string) error { return nil }

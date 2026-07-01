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
	// 按号服务档:归一为出口口径("fast"→"priority",空/标准→"")。透出到 auth 记录,
	// 便于诊断/日志,也是未来 egress 注入的读取点。
	//
	// TODO(wave-L, egress-hook):把「快速档号」出口请求体注入 service_tier:"priority" 尚未接线。
	// 原因:嵌入式 CLIProxyAPI(v7.2.47)没有暴露「逐号请求体修改」的钩子——
	//   1) cliproxy.Hooks 只有 OnBeforeStart/OnAfterStart(生命周期),无逐请求钩子;
	//   2) codex 出口请求体由 SDK 内部 CodexExecutor.Execute 构建,且其 codex 请求翻译器
	//      (internal/translator/codex/openai/responses/codex_openai-responses_request.go)会主动
	//      删除入站 body 里的 service_tier;config.CodexKey 也无 service-tier 字段。
	// 故要真正带上 service_tier 需 fork/patch 供应商 SDK 的 executor 或 translator —— 属高风险、
	// 越界改动(见 spec 红线:本地网关只服务 codex 自有号,不动反代/远程租号内部)。本波暂以
	// 「持久化 + 视图 + 绑定 + 前端 UI」交付,egress 注入待 SDK 提供逐请求/逐号钩子后接线。
	svcTier := account.NormalizeServiceTier(a.ServiceTier)
	upstreamTier := ""
	if svcTier == "fast" {
		upstreamTier = "priority" // 上游 service_tier 口径
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
			"service_tier":  upstreamTier, // 快速档→"priority";标准/继承→""(egress 注入待接线,见上 TODO)
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
	rem := a.HourlyPercent
	if a.WeeklyPercent < rem {
		rem = a.WeeklyPercent
	}
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

package manager

import (
	"errors"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/quota"
)

// Refresher 抽象「按号刷 token + 拉额度」(provider 特定,注入便于测试 mock 上游)。
// 移植自 cockpit codex_quota::refresh_account_quota_once 的步骤(token 过期先刷、再拉额度)。
type Refresher interface {
	// TokenExpired 报告 access_token 是否已过期(JWT exp,见 quota.isJWTExpired)。
	TokenExpired(a *account.Account) bool
	// RefreshToken 就地续约 a 的 token(写回 a.AccessToken/RefreshToken/IDToken/Expiry)。
	RefreshToken(a *account.Account) error
	// FetchQuota 拉一次额度(上游端点照搬 cockpit)。
	FetchQuota(a *account.Account) (quota.Result, error)
}

// SetRefresher 注入 provider 的额度/续约能力(hub 构造时按 provider 注入)。
func (m *Manager) SetRefresher(r Refresher) { m.refresher = r }

// RefreshQuota 刷新单个账号额度并持久化,照搬 cockpit refresh_account_quota_once:
//  1. API Key 号不支持 -> 返回错误;
//  2. token 过期则先续约并持久化;
//  3. 拉额度,成功回填 HourlyPercent/WeeklyPercent + reset + plan + QuotaOK;
//  4. 失败写 QuotaError + reason 并持久化,返回错误。
func (m *Manager) RefreshQuota(id string) error {
	a, err := m.acc.Get(id)
	if err != nil {
		return err
	}
	return m.refreshOne(a)
}

// RefreshAllQuotas 遍历本 provider 的 pool_enabled 自有号逐个刷新,返回成功刷新数量。
// 单号失败不中断(对齐 cockpit refresh_all_quotas:逐号独立)。
func (m *Manager) RefreshAllQuotas() (int, error) {
	list, err := m.acc.ListPoolEnabled(m.provider)
	if err != nil {
		return 0, err
	}
	ok := 0
	for _, a := range list {
		if err := m.refreshOne(a); err == nil {
			ok++
		}
	}
	return ok, nil
}

func (m *Manager) refreshOne(a *account.Account) error {
	if m.refresher == nil {
		return errors.New("manager: 未配置额度刷新能力")
	}
	if a.AuthKind == account.AuthAPIKey {
		return errors.New("API Key 账号不支持刷新配额，请在网页端查看。")
	}

	// 1) token 过期先续约(对齐 cockpit:Token 已过期 -> 强制刷新 -> 保存)。
	if m.refresher.TokenExpired(a) {
		if err := m.refresher.RefreshToken(a); err != nil {
			m.markQuotaError(a, "Token 刷新失败: "+err.Error())
			return err
		}
		if err := m.acc.Update(a); err != nil {
			return err
		}
	}

	// 2) 拉额度。
	res, err := m.refresher.FetchQuota(a)
	if err != nil {
		m.markQuotaError(a, err.Error())
		return err
	}

	// 3) 回填并持久化。仅当上游真给了该窗口才写,缺窗口 keep-prior——
	// 绝不用伪造满血覆盖既有真实剩余(见 quota.parseQuotaFromUsage 注释)。
	if res.HourlyKnown {
		a.HourlyPercent = res.HourlyPercent
		a.HourlyResetAt = res.HourlyResetAt
	}
	if res.WeeklyKnown {
		a.WeeklyPercent = res.WeeklyPercent
		a.WeeklyResetAt = res.WeeklyResetAt
	}
	if res.PlanType != "" {
		a.PlanType = res.PlanType
	}
	// 只有真拿到窗口数据才宣告 OK;全未知(如 antigravity 无窗口)则 keep-prior 状态,
	// 避免每轮自动刷新把冷却/错误态清成 OK。
	if res.HourlyKnown || res.WeeklyKnown {
		a.QuotaStatus = account.QuotaOK
		a.QuotaReason = ""
	}
	return m.acc.Update(a)
}

func (m *Manager) markQuotaError(a *account.Account, reason string) {
	a.QuotaStatus = account.QuotaError
	a.QuotaReason = reason
	_ = m.acc.Update(a)
}

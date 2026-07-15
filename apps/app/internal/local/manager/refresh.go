package manager

import (
	"errors"
	"sync"
	"sync/atomic"

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

// quotaRefreshMaxConcurrent 批量刷额度的并发上限,对齐 cockpit(codex 池 max 5)。
//
// 为什么是「有界」而不是两个极端(cockpit 两个坑都踩过,见其 ab84211f):
//   - 全串行:号一多就是干等,甚至超时(GFA 原来就是这样);
//   - 无限并发:一次扇出几十个号,把上游打限流、部分失败、抖动。
//
// 瓶颈在网络拉额度,不在写库(account.Store 用 database/sql,并发安全、写自动串行)。
const quotaRefreshMaxConcurrent = 5

// RefreshAllQuotas 刷新本 provider 的【全部】自有号额度,返回成功刷新数量。
// 不再只刷在池号(对齐 cockpit refresh_all_quotas:全量、逐号独立)——未在池的号
// 也要能一键刷额度,否则用户得逐个点。API Key 号 refreshOne 会返回错误、不计入成功数。
// 单号失败不中断;并发上限见 quotaRefreshMaxConcurrent。
func (m *Manager) RefreshAllQuotas() (int, error) {
	list, err := m.acc.List(m.provider)
	if err != nil {
		return 0, err
	}
	var (
		ok  int64
		wg  sync.WaitGroup
		sem = make(chan struct{}, quotaRefreshMaxConcurrent)
	)
	for _, a := range list {
		wg.Add(1)
		go func(a *account.Account) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := m.refreshOne(a); err == nil {
				atomic.AddInt64(&ok, 1)
			}
		}(a)
	}
	wg.Wait()
	return int(ok), nil
}

// accountRefreshLock 取该账号的刷新锁(没有就建)。见 Manager.refreshLocks 注释。
func (m *Manager) accountRefreshLock(id string) *sync.Mutex {
	v, _ := m.refreshLocks.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}

func (m *Manager) refreshOne(a *account.Account) error {
	// 每号一把锁:同一账号绝不并发刷(续 token 会轮换 refresh_token,并发会互相作废)。
	lk := m.accountRefreshLock(a.ID)
	lk.Lock()
	defer lk.Unlock()

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
	if res.HourlyPresent != nil && !*res.HourlyPresent {
		a.HourlyPercent = -1
		a.HourlyResetAt = 0
	} else if res.HourlyKnown {
		a.HourlyPercent = res.HourlyPercent
		a.HourlyResetAt = res.HourlyResetAt
	}
	if res.WeeklyPresent != nil && !*res.WeeklyPresent {
		a.WeeklyPercent = -1
		a.WeeklyResetAt = 0
	} else if res.WeeklyKnown {
		a.WeeklyPercent = res.WeeklyPercent
		a.WeeklyResetAt = res.WeeklyResetAt
	}
	if res.PlanType != "" {
		a.PlanType = res.PlanType
	}
	// 多桶(antigravity gemini/claude × 5h/周):拿到就整体覆盖;空则 keep-prior。
	if len(res.Buckets) > 0 {
		a.Buckets = res.Buckets
	}
	// 只有真拿到窗口数据才宣告 OK;全未知(如 antigravity 无窗口)则 keep-prior 状态,
	// 避免每轮自动刷新把冷却/错误态清成 OK。
	if res.HourlyKnown || res.WeeklyKnown || len(res.Buckets) > 0 {
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

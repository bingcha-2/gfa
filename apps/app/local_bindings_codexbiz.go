package main

import "bcai-wails/internal/local/codexbiz"

// codex 上游业务(① 订阅 ② 主动重置次数 ③ 邀请返利)Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:codex 自有号查自己的订阅/返利,等同额度刷新路径;不碰远程租号 / 网关出口。

// ── ① 订阅 ──

func (a *App) LocalRefreshCodexSubscription(id string) (codexbiz.SubscriptionSnapshot, error) {
	if err := ensureLocal(); err != nil {
		return codexbiz.SubscriptionSnapshot{}, err
	}
	return localHub.RefreshCodexSubscription(id)
}

// ── ② 主动重置次数 ──

func (a *App) LocalGetCodexResetCredits(id string) (codexbiz.ResetCreditsSnapshot, error) {
	if err := ensureLocal(); err != nil {
		return codexbiz.ResetCreditsSnapshot{}, err
	}
	return localHub.GetCodexResetCredits(id)
}

// LocalConsumeCodexResetCredit 消费一次主动重置;redeemRequestID 传空串时 hub 自动生成 UUID。
func (a *App) LocalConsumeCodexResetCredit(id, redeemRequestID string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.ConsumeCodexResetCredit(id, redeemRequestID)
}

// ── ③ 邀请返利 ──

func (a *App) LocalCodexReferralEligibility(id, referralKey string) (codexbiz.ReferralInviteEligibility, error) {
	if err := ensureLocal(); err != nil {
		return codexbiz.ReferralInviteEligibility{}, err
	}
	return localHub.CodexReferralEligibility(id, referralKey)
}

func (a *App) LocalCodexReferralRules(id, referralKey string) (codexbiz.ReferralEligibilityRules, error) {
	if err := ensureLocal(); err != nil {
		return codexbiz.ReferralEligibilityRules{}, err
	}
	return localHub.CodexReferralRules(id, referralKey)
}

// LocalSendCodexReferralInvites 给 codex 自有号发邀请(emails 1..=5,hub 内 trim/去空/校验)。
func (a *App) LocalSendCodexReferralInvites(id, referralKey string, emails []string) (codexbiz.ReferralInviteResponse, error) {
	if err := ensureLocal(); err != nil {
		return codexbiz.ReferralInviteResponse{}, err
	}
	return localHub.SendCodexReferralInvites(id, referralKey, emails)
}

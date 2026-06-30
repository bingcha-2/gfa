package hub

import (
	"fmt"
	"net/http"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codexbiz"
)

// codex 上游业务(订阅 / 主动重置次数 / 邀请返利)的薄委托。
//
// codexbiz 包是自包含上游业务面(不做 token 刷新/持久化/401 重试)。本文件负责:
//   - 按账号 id 取出 codex 自有号,过期则用 codex refresher 先刷 token 再持久化;
//   - 适配成 codexbiz.Account(AccessToken/AccountID)调上游;
//   - 用一个带超时的 *http.Client 直连 chatgpt.com(用户自有号查自己的订阅/返利)。
//
// 红线:这是 codex 自有号的上游业务查询,等同 quota 刷新路径,与远程租号 / 网关出口无关。

const codexBizHTTPTimeout = 30 * time.Second

// codexBizClient 懒构造一个 codexbiz.Client(默认端点 + 带超时的 http.Client)。
func (h *Hub) codexBizClient() *codexbiz.Client {
	return codexbiz.NewClient(codexbiz.Options{
		Doer: &http.Client{Timeout: codexBizHTTPTimeout},
	})
}

// codexBizAccount 按 id 取 codex 自有号,过期则刷 token 后持久化,适配成 codexbiz.Account。
func (h *Hub) codexBizAccount(id string) (codexbiz.Account, error) {
	a, err := h.acc.Get(id)
	if err != nil {
		return codexbiz.Account{}, err
	}
	if a.Provider != account.ProviderCodex {
		return codexbiz.Account{}, fmt.Errorf("hub: 账号 %q 不是 codex 自有号", id)
	}
	pc, err := h.ctx(account.ProviderCodex)
	if err != nil {
		return codexbiz.Account{}, err
	}
	if a.AuthKind != account.AuthAPIKey && pc.refresher.TokenExpired(a) {
		if err := pc.refresher.RefreshToken(a); err != nil {
			return codexbiz.Account{}, err
		}
		if err := h.acc.Update(a); err != nil {
			return codexbiz.Account{}, err
		}
	}
	return codexbiz.Account{AccessToken: a.AccessToken, AccountID: a.AccountID}, nil
}

// ── ① 订阅 ──

// RefreshCodexSubscription 拉某 codex 自有号的订阅快照(accounts/check → subscriptions 回退)。
func (h *Hub) RefreshCodexSubscription(id string) (codexbiz.SubscriptionSnapshot, error) {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return codexbiz.SubscriptionSnapshot{}, err
	}
	return h.codexBizClient().RefreshSubscription(acc)
}

// ── ② 主动重置次数 ──

// GetCodexResetCredits 拉某 codex 自有号的主动重置次数明细。
func (h *Hub) GetCodexResetCredits(id string) (codexbiz.ResetCreditsSnapshot, error) {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return codexbiz.ResetCreditsSnapshot{}, err
	}
	return h.codexBizClient().GetResetCredits(acc)
}

// ConsumeCodexResetCredit 消费某 codex 自有号一次主动重置(redeemRequestID 空则自动生成 UUID)。
func (h *Hub) ConsumeCodexResetCredit(id, redeemRequestID string) error {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return err
	}
	return h.codexBizClient().ConsumeResetCredit(acc, redeemRequestID)
}

// ── ③ 邀请返利 ──

// CodexReferralEligibility 查某 codex 自有号的邀请返利资格(referralKey 空则用默认 key)。
func (h *Hub) CodexReferralEligibility(id, referralKey string) (codexbiz.ReferralInviteEligibility, error) {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return codexbiz.ReferralInviteEligibility{}, err
	}
	return h.codexBizClient().ReferralEligibility(acc, referralKey)
}

// CodexReferralRules 查某 codex 自有号的邀请返利规则。
func (h *Hub) CodexReferralRules(id, referralKey string) (codexbiz.ReferralEligibilityRules, error) {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return codexbiz.ReferralEligibilityRules{}, err
	}
	return h.codexBizClient().ReferralRules(acc, referralKey)
}

// SendCodexReferralInvites 给某 codex 自有号发邀请(emails 1..=5,内部 trim/去空/校验)。
func (h *Hub) SendCodexReferralInvites(id, referralKey string, emails []string) (codexbiz.ReferralInviteResponse, error) {
	acc, err := h.codexBizAccount(id)
	if err != nil {
		return codexbiz.ReferralInviteResponse{}, err
	}
	return h.codexBizClient().SendReferralInvites(acc, referralKey, emails)
}

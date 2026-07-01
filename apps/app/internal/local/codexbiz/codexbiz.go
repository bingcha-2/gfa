// Package codexbiz 直接照 cockpit 移植 codex 上游业务调用(订阅 / 主动重置次数 / 邀请返利)。
//
// 移植自 cockpit crates/cockpit-core/src/modules/codex_quota.rs:
//   - RefreshSubscription  <- refresh_subscription_state / fetch_subscription_status_snapshot
//     (GET accounts/check/v4-2023-04-27,过期则回退 GET subscriptions)。
//   - GetResetCredits      <- fetch_reset_credits (GET wham/rate-limit-reset-credits)。
//   - ConsumeResetCredit   <- post_reset_credit_once (POST wham/rate-limit-reset-credits/consume)。
//   - ReferralEligibility  <- fetch_referral_invite_eligibility_once
//     (GET referrals/invite/eligibility)。
//   - ReferralRules        <- fetch_referral_eligibility_rules_once
//     (GET wham/referrals/eligibility_rules)。
//   - SendReferralInvites  <- send_referral_invites_once (POST wham/referrals/invite)。
//
// 端点 / 头 / 解析逐字对齐 cockpit。本包自包含:不依赖 internal/local/account,
// 也不碰共享文件(hub.go / local_bindings.go / proxy.go);上游调用走注入的 httpDoer 便于 mock。
// 本包只做上游业务,不负责 token 刷新 / 持久化 / 401 重试(那些归编排层 hub)。
package codexbiz

import "net/http"

// HTTPDoer 是注入的 HTTP 执行器(*http.Client 满足此接口),便于单测 mock。
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Account 是调用上游所需的最小账号视图(自包含,不耦合 account.Account)。
type Account struct {
	AccessToken string // OAuth access_token(JWT;codex 不验签)
	AccountID   string // upstream ChatGPT-Account-Id;空则从 AccessToken 提取
}

// Endpoints 是可覆盖的上游端点(默认值见 NewClient;测试可注入 mock URL)。
type Endpoints struct {
	AccountsCheckURL       string
	SubscriptionsURL       string
	ResetCreditsURL        string
	ResetCreditsConsumeURL string
	ReferralEligibilityURL string
	ReferralRulesURL       string
	ReferralInviteURL      string
}

// Options 配置 Client。
type Options struct {
	Doer      HTTPDoer  // 必填(测试注入 mock;生产传 *http.Client)
	Endpoints Endpoints // 可空,空字段回退默认端点
}

// Client 封装 codex 上游业务调用。
type Client struct {
	doer HTTPDoer
	ep   Endpoints
}

// ── 照搬 cockpit codex_quota.rs 的上游常量 ──
const (
	defaultAccountsCheckURL       = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
	defaultSubscriptionsURL       = "https://chatgpt.com/backend-api/subscriptions"
	defaultResetCreditsURL        = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	defaultResetCreditsConsumeURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
	defaultReferralEligibilityURL = "https://chatgpt.com/backend-api/referrals/invite/eligibility"
	defaultReferralRulesURL       = "https://chatgpt.com/backend-api/wham/referrals/eligibility_rules"
	defaultReferralInviteURL      = "https://chatgpt.com/backend-api/wham/referrals/invite"

	chatGPTWebReferer   = "https://chatgpt.com/"
	chatGPTWebUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

	// DefaultReferralKey 照搬 CODEX_REFERRAL_PERSISTENT_INVITE_KEY。
	DefaultReferralKey = "codex_referral_persistent_invite"
)

// NewClient 构造 Client;Endpoints 的空字段回退默认端点。
func NewClient(opts Options) *Client {
	ep := opts.Endpoints
	if ep.AccountsCheckURL == "" {
		ep.AccountsCheckURL = defaultAccountsCheckURL
	}
	if ep.SubscriptionsURL == "" {
		ep.SubscriptionsURL = defaultSubscriptionsURL
	}
	if ep.ResetCreditsURL == "" {
		ep.ResetCreditsURL = defaultResetCreditsURL
	}
	if ep.ResetCreditsConsumeURL == "" {
		ep.ResetCreditsConsumeURL = defaultResetCreditsConsumeURL
	}
	if ep.ReferralEligibilityURL == "" {
		ep.ReferralEligibilityURL = defaultReferralEligibilityURL
	}
	if ep.ReferralRulesURL == "" {
		ep.ReferralRulesURL = defaultReferralRulesURL
	}
	if ep.ReferralInviteURL == "" {
		ep.ReferralInviteURL = defaultReferralInviteURL
	}
	doer := opts.Doer
	if doer == nil {
		doer = http.DefaultClient
	}
	return &Client{doer: doer, ep: ep}
}

// chatGPTAccountID 优先用显式 AccountID,否则从 access_token JWT 提取。
// 照搬 cockpit:account.account_id.or_else(extract_chatgpt_account_id_from_access_token)。
func (a Account) chatGPTAccountID() string {
	if id := normalizeOptional(a.AccountID); id != "" {
		return id
	}
	return extractChatGPTAccountID(a.AccessToken)
}

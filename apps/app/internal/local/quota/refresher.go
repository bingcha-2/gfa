package quota

import (
	"time"

	"bcai-wails/internal/local/account"
)

// 这里的 CodexRefresher/AntigravityRefresher 实现 manager.Refresher 接口
//(结构化满足:TokenExpired/RefreshToken/FetchQuota),由 hub 按 provider 注入。
// 放在 quota 包以避免 manager<->quota 反向依赖(manager 仅 import quota.Result)。

const antigravityRefreshSkewSeconds = 60

// CodexRefresher 把 CodexFetcher 适配成 manager.Refresher。
type CodexRefresher struct{ f *CodexFetcher }

func NewCodexRefresher(ep CodexEndpoints) *CodexRefresher {
	return &CodexRefresher{f: NewCodexFetcher(ep)}
}

// TokenExpired 用 access_token 的 JWT exp 判过期(照搬 cockpit is_token_expired)。
func (r *CodexRefresher) TokenExpired(a *account.Account) bool {
	return isJWTExpired(a.AccessToken)
}

func (r *CodexRefresher) RefreshToken(a *account.Account) error {
	tok, err := r.f.RefreshToken(a.RefreshToken, a.IDToken)
	if err != nil {
		return err
	}
	a.IDToken = tok.IDToken
	a.AccessToken = tok.AccessToken
	a.RefreshToken = tok.RefreshToken
	return nil
}

func (r *CodexRefresher) FetchQuota(a *account.Account) (Result, error) {
	return r.f.FetchQuota(a)
}

// AntigravityRefresher 适配 antigravity。antigravity 上游不暴露 5h/周额度细项,
// 保活靠 RefreshToken(刷 access_token 即视为存活);FetchQuota 两窗口都报「未知」,
// 绝不伪造满血(否则 fair-share 血条卡死,见 codex-quota-window-unknown-parity)。
type AntigravityRefresher struct{ f *AntigravityFetcher }

func NewAntigravityRefresher(ep AntigravityEndpoints) *AntigravityRefresher {
	return &AntigravityRefresher{f: NewAntigravityFetcher(ep)}
}

// TokenExpired 用 account.Expiry(unix 秒)判,留 skew;Expiry=0(未知)按未过期。
func (r *AntigravityRefresher) TokenExpired(a *account.Account) bool {
	if a.Expiry <= 0 {
		return false
	}
	return time.Now().Unix()+antigravityRefreshSkewSeconds >= a.Expiry
}

func (r *AntigravityRefresher) RefreshToken(a *account.Account) error {
	tok, err := r.f.RefreshToken(a.RefreshToken)
	if err != nil {
		return err
	}
	a.AccessToken = tok.AccessToken
	if tok.Expiry > 0 {
		a.Expiry = tok.Expiry
	}
	return nil
}

// FetchQuota:antigravity 无 5h/周窗口口径,两窗口都报「未知」(Known=false)——
// 调用方据此 keep-prior、不写、也不把 QuotaStatus 强刷成 OK,避免每轮自动刷新
// 把 antigravity 号的状态(冷却/百分比)清掉(见 manager.refreshOne)。
func (r *AntigravityRefresher) FetchQuota(a *account.Account) (Result, error) {
	return Result{}, nil
}

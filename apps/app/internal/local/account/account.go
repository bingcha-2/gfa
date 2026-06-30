// Package account 管理「本地自有号」的持久化(SQLite)。
// 这是本地接管模式下用户自己 OAuth 登录的账号的单一事实源;
// 远程租号绝不进入此处(见 docs/superpowers/specs/2026-06-30-gfa-local-takeover-design.md §3)。
package account

type Provider string

const (
	ProviderCodex       Provider = "codex"
	ProviderAntigravity Provider = "antigravity"
)

type AuthKind string

const (
	AuthOAuth  AuthKind = "oauth"
	AuthAPIKey AuthKind = "apikey"
)

type QuotaStatus string

const (
	QuotaOK        QuotaStatus = "ok"
	QuotaError     QuotaStatus = "error"
	QuotaCooling   QuotaStatus = "cooling"
	QuotaExhausted QuotaStatus = "exhausted"
)

// Account 是一个本地自有号。字段对齐 cockpit CodexAccount 关键项 +
// rosetta 的健康态模式(QuotaStatus/BlockedUntil)。
type Account struct {
	ID            string
	Provider      Provider
	Email         string
	Name          string // 显示名(可空,用户自定义)
	AuthKind      AuthKind
	IDToken       string
	AccessToken   string
	RefreshToken  string
	APIKey        string // 自备 API Key 号
	APIBaseURL    string // 自备 API Key 号
	AccountID     string // upstream account id
	ProjectID     string // Google Cloud project(antigravity 用)
	Expiry        int64  // access_token 过期时刻,unix 秒(antigravity 注入需真值,0=未知)
	IsGCPTos      bool   // 是否已接受 GCP 服务条款(antigravity 企业号;gmail 恒为 false)
	PlanType      string // pro/plus/team/free
	Tags          []string
	Note          string
	PoolEnabled   bool // 是否进网关池
	Priority      bool // 优先出口
	SortOrder     int  // 手动排序序号(越小越靠前;默认 0 时按 created_at 兜底)
	QuotaStatus   QuotaStatus
	QuotaReason   string
	HourlyPercent int
	WeeklyPercent int
	HourlyResetAt int64 // unix ms
	WeeklyResetAt int64
	BlockedUntil  int64 // unix ms 冷却
	CreatedAt     int64
	LastUsedAt    int64
	UpdatedAt     int64
}

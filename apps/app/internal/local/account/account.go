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

// QuotaBucket 是一个「按窗口/模型族」的剩余额度桶(antigravity 多桶展示用)。
// 照搬 cockpit antigravity 的 4 桶模型:gemini-5h/gemini-weekly/3p-5h/3p-weekly。
// codex 仍走 HourlyPercent/WeeklyPercent 两窗口;此字段为空即不展示多桶。
type QuotaBucket struct {
	Key     string `json:"key"`     // gemini-5h / gemini-weekly / 3p-5h / 3p-weekly
	Label   string `json:"label"`   // 展示名(如 "Gemini · 5 小时")
	Percent int    `json:"percent"` // 剩余 0..100
	ResetAt int64  `json:"resetAt"` // 下次重置 unix ms(0=未知)
}

// Account 是一个本地自有号。字段对齐 cockpit CodexAccount 关键项 +
// rosetta 的健康态模式(QuotaStatus/BlockedUntil)。
type Account struct {
	ID           string
	Provider     Provider
	Email        string
	Name         string // 显示名(可空,用户自定义)
	AuthKind     AuthKind
	IDToken      string
	AccessToken  string
	RefreshToken string
	APIKey       string // 自备 API Key 号
	APIBaseURL   string // 自备 API Key 号
	AccountID    string // upstream account id
	ProjectID    string // Google Cloud project(antigravity 用)
	Expiry       int64  // access_token 过期时刻,unix 秒(antigravity 注入需真值,0=未知)
	IsGCPTos     bool   // 是否已接受 GCP 服务条款(antigravity 企业号;gmail 恒为 false)
	PlanType     string // pro/plus/team/free
	Tags         []string
	Note         string
	PoolEnabled  bool // 是否进网关池
	Priority     bool // 优先出口
	SortOrder    int  // 手动排序序号(越小越靠前;默认 0 时按 created_at 兜底)
	// ServiceTier 是「按号服务档」(codex 专属,对齐 cockpit accounts.updateAppSpeed /
	// config.apiServiceAppSpeed):""(=继承/standard)| "fast"(=priority)。
	// 语义映射对齐 cockpit codex_speed.normalize_service_tier_speed:{fast,priority,flex}→fast,其余→standard。
	ServiceTier   string
	QuotaStatus   QuotaStatus
	QuotaReason   string
	HourlyPercent int
	WeeklyPercent int
	HourlyResetAt int64 // unix ms
	WeeklyResetAt int64
	// Buckets 是多窗口/多模型族剩余额度(antigravity 4 桶);codex 留空。
	Buckets      []QuotaBucket
	BlockedUntil int64 // unix ms 冷却
	CreatedAt    int64
	LastUsedAt   int64
	UpdatedAt    int64
}

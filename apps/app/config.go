package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Build-time injectable base domains (override via ldflags -X main.buildAPIBase=... -X main.buildApexBase=...)
var buildAPIBase = "https://api.bcai.lol"
var buildApexBase = "https://bcai.lol"

type Config struct {
	// ── Legacy card-key fields (kept for old config file parsing; not used for runtime auth) ──
	AccountCard string `json:"accountCard"` // kept for backward-compat; runtime no longer reads this for auth
	CardExpiry  string `json:"cardExpiry"`  // kept for backward-compat

	DeviceId     string `json:"deviceId"`
	ProxyPort    int    `json:"proxyPort"`
	IDEPath      string `json:"idePath"` // 用户自定义 IDE 安装路径（留空则自动检测）
	HubPath      string `json:"hubPath"` // 用户自定义 Hub 安装路径（留空则自动检测）
	CodexAppPath string `json:"codexAppPath"`
	// 用户自定义 Claude 桌面端可执行文件路径(留空则自动检测)。逃生口:自动检测漏掉
	// 非标准安装/提权导致 %LOCALAPPDATA% 偏移时,用户可手动指定,无需 Claude 先开着。
	ClaudeDesktopPath string `json:"claudeDesktopPath"`

	// ── Account-login fields (new) ──
	UserToken       string `json:"userToken"`       // session JWT from /app/login
	UserTokenExpiry string `json:"userTokenExpiry"` // ISO-8601 expiry
	UserEmail       string `json:"userEmail"`       // account email
	UserId          string `json:"userId"`          // stable server customer id; local stats namespace
	PlanName        string `json:"planName"`        // subscription plan name
	PlanExpiry      string `json:"planExpiry"`      // subscription expiry (ISO-8601 or null string)
	PlanDeviceMax   int    `json:"planDeviceMax"`   // device limit from subscription
	DeviceName      string `json:"deviceName"`      // hostname + " (" + GOOS + ")"

	// Subscriptions 是登录/心跳取到的「全部生效订阅」快照(服务端按 priority 升序),
	// 用于客户端展示多订阅(接力顺序)。PlanName/PlanExpiry/PlanDeviceMax 仍保留为
	// 「首订阅」派生,供既有单订阅 UI/判定兼容。心跳用服务端 subscriptions[] 覆盖刷新;
	// 登出清空。
	Subscriptions []SubscriptionSnapshot `json:"subscriptions"`
	ServerUsage   *ServerUsageSummary    `json:"serverUsage,omitempty"`

	// Codex 中转(API 卡密)模式:不租号、不要 card,用本地配置的 key 直连第三方
	// 中转站。CodexMode=="relay" 且 base/key 齐全时启用;否则走原有号池/租号流程。
	CodexMode          string            `json:"codexMode"`          // "" / "rental" (默认) 或 "relay"
	CodexRelayBase     string            `json:"codexRelayBase"`     // 中转站基址,请求落在 {base}/responses 或 /chat/completions
	CodexRelayKey      string            `json:"codexRelayKey"`      // 中转卡密(Authorization: Bearer)
	CodexRelayProtocol string            `json:"codexRelayProtocol"` // "" / "responses" (默认) 或 "chat"(通用 OpenAI 中转)
	CodexModelMap      map[string]string `json:"codexModelMap"`      // 可选:客户端模型名 → 中转模型名

	// 接管时给 Codex 桌面版写「快速(Fast)」服务档:config.toml [desktop].default-service-tier=
	// "priority" + 同步 .codex-global-state.json 原子态(对齐 cockpit codex_speed)。桌面版 Codex
	// 没有逐次的 fast 选择器,速度档是全局配置,这样它每条生成请求都会带 service_tier=priority;
	// 真正是否放行仍由代理按服务端授权闸 + 被租号能力门控(见 codex_service_tier.go / applyCodexServiceTier)。
	// 默认 false(标准档,零行为变化);置 true 开启桌面快速档。
	CodexFastMode bool `json:"codexFastMode"`
}

// SubscriptionSnapshot 是单个生效订阅的客户端展示快照。catalog 化后订阅无 planName,
// 产品由 Products[] 决定;ExpiresAt 为空串表示长期有效。字段对齐服务端
// /app/login、/app/heartbeat 的 subscriptions[] 元素。
type SubscriptionSnapshot struct {
	Id          string            `json:"id"`
	Status      string            `json:"status"`
	ExpiresAt   string            `json:"expiresAt"`
	DeviceLimit int               `json:"deviceLimit"`
	Priority    int               `json:"priority"`
	Products    []string          `json:"products"`
	Levels      map[string]string `json:"levels"`
	// UsdQuotaByProduct 是该订阅内各产品彼此独立的 API 等价美元额度。
	UsdQuotaByProduct map[string]SubscriptionProductUsdQuota `json:"usdQuotaByProduct,omitempty"`
	Exclusive         bool                                   `json:"exclusive"`
	ShareSeats        int                                    `json:"shareSeats"`
}

type SubscriptionProductUsdQuota struct {
	FiveHour *SubscriptionUsdQuotaWindow `json:"fiveHour"`
	Weekly   *SubscriptionUsdQuotaWindow `json:"weekly"`
}

type SubscriptionUsdQuotaWindow struct {
	Used    float64 `json:"used"`
	Limit   float64 `json:"limit"`
	ResetAt string  `json:"resetAt"`
}

var (
	configLock sync.RWMutex

	// origConfigDir allows tests to redirect config to a temp directory.
	// Set to a non-empty path before calling LoadConfig/SaveConfig/configFilePath.
	origConfigDir string
)

func getAppDataDir() string {
	if origConfigDir != "" {
		return origConfigDir
	}
	base, err := os.UserConfigDir()
	if err != nil {
		// fallback: 极端情况下 $HOME 未定义等
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "BingchaAI")
}

// getEnvOrDefault 读取环境变量，为空则返回默认值
func getEnvOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

// getEnvDurationOrDefault 读取形如 "15s"/"5m" 的时长环境变量；缺省或非法则返回 defaultVal。
func getEnvDurationOrDefault(key string, defaultVal time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return defaultVal
}

func configFilePath() string {
	return filepath.Join(getAppDataDir(), "config.json")
}

func DefaultConfig() Config {
	return Config{
		AccountCard: "",
		DeviceId:    "",
		ProxyPort:   DefaultProxyPort,
	}
}

func LoadConfig() Config {
	configLock.Lock()
	defer configLock.Unlock()

	cfg := DefaultConfig()
	file := configFilePath()

	data, err := os.ReadFile(file)
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}

	// 确保端口有效
	if cfg.ProxyPort <= 0 {
		cfg.ProxyPort = DefaultProxyPort
	}

	return cfg
}

func SaveConfig(cfg Config) error {
	configLock.Lock()
	defer configLock.Unlock()

	if cfg.ProxyPort <= 0 {
		cfg.ProxyPort = DefaultProxyPort
	}

	dir := getAppDataDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	file := configFilePath()
	// Atomic + durable (temp file + fsync + rename) so a crash/power-loss can't
	// leave a half-written or truncated config.json.
	if err := writeFileAtomic(file, data, 0600); err != nil {
		return err
	}

	return nil
}

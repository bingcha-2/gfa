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
	PlanName        string `json:"planName"`        // subscription plan name
	PlanExpiry      string `json:"planExpiry"`      // subscription expiry (ISO-8601 or null string)
	PlanDeviceMax   int    `json:"planDeviceMax"`   // device limit from subscription
	DeviceName      string `json:"deviceName"`      // hostname + " (" + GOOS + ")"

	// Subscriptions 是登录/心跳取到的「全部生效订阅」快照(服务端按 priority 升序),
	// 用于客户端展示多订阅(接力顺序)。PlanName/PlanExpiry/PlanDeviceMax 仍保留为
	// 「首订阅」派生,供既有单订阅 UI/判定兼容。心跳用服务端 subscriptions[] 覆盖刷新;
	// 登出清空。
	Subscriptions []SubscriptionSnapshot `json:"subscriptions"`

	// Codex 中转(API 卡密)模式:不租号、不要 card,用本地配置的 key 直连第三方
	// 中转站。CodexMode=="relay" 且 base/key 齐全时启用;否则走原有号池/租号流程。
	CodexMode          string            `json:"codexMode"`          // "" / "rental" (默认) 或 "relay"
	CodexRelayBase     string            `json:"codexRelayBase"`     // 中转站基址,请求落在 {base}/responses 或 /chat/completions
	CodexRelayKey      string            `json:"codexRelayKey"`      // 中转卡密(Authorization: Bearer)
	CodexRelayProtocol string            `json:"codexRelayProtocol"` // "" / "responses" (默认) 或 "chat"(通用 OpenAI 中转)
	CodexModelMap      map[string]string `json:"codexModelMap"`      // 可选:客户端模型名 → 中转模型名
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
	// RemainFraction 是该订阅「最紧复合桶」的剩余额度比例(0-1);nil=无限额/无数据。
	// 用于客户端多订阅余量条 —— 区分同产品同到期的订阅(谁在消耗、谁备用满额)。
	RemainFraction *float64 `json:"remainFraction"`
	// ProductQuota 是该订阅每个产品(绑定号)的整号 5h/周剩余,供逐订阅按产品画 5h/周血条。
	// 来自服务端心跳(读 AccountQuotaSnapshot);空/缺产品 = 暂无该产品额度数据。
	ProductQuota map[string]ProductQuotaWindow `json:"productQuota,omitempty"`
}

// ProductQuotaWindow 单产品整号 5h/周剩余(百分比 0-100;nil=无数据)。与服务端 buildSubscriptionSummary 对齐。
// My* 字段:该订阅在绑定母号上的「我的份额」(fair-share,0-1),供逐订阅画双层血条
// (母号 HourlyPercent 打底 + 我的 MyHourlyFraction 叠加)。nil=服务端未下发/取不到 → 客户端退单层。
// MyShare=e_i(我的份额占整号比例,双层外层几何)。不加这些字段,Go 解析会静默丢掉它们。
type ProductQuotaWindow struct {
	HourlyPercent *float64 `json:"hourlyPercent"`
	WeeklyPercent *float64 `json:"weeklyPercent"`
	HourlyResetAt string   `json:"hourlyResetAt"`
	WeeklyResetAt string   `json:"weeklyResetAt"`

	MyHourlyFraction *float64 `json:"myHourlyFraction,omitempty"`
	MyWeeklyFraction *float64 `json:"myWeeklyFraction,omitempty"`
	MyShare          *float64 `json:"myShare,omitempty"`
	// Exclusive=独享(营销标签):权威标志。true → 前端血条画单层「剩余 X%」,不走拼车双层。
	// 不加此字段,Go 解析会静默丢掉服务端下发的 exclusive,前端永远收不到。
	Exclusive *bool `json:"exclusive,omitempty"`
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

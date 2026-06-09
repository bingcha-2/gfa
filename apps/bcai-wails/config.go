package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Config struct {
	AccountCard   string `json:"accountCard"`
	DeviceId      string `json:"deviceId"`
	ProxyPort     int    `json:"proxyPort"`
	UpstreamProxy string `json:"upstreamProxy"`
	IDEPath       string `json:"idePath"` // 用户自定义 IDE 安装路径（留空则自动检测）
	HubPath       string `json:"hubPath"` // 用户自定义 Hub 安装路径（留空则自动检测）
	CodexAppPath  string `json:"codexAppPath"`
	// 用户自定义 Claude 桌面端可执行文件路径(留空则自动检测)。逃生口:自动检测漏掉
	// 非标准安装/提权导致 %LOCALAPPDATA% 偏移时,用户可手动指定,无需 Claude 先开着。
	ClaudeDesktopPath string `json:"claudeDesktopPath"`
	CardExpiry        string `json:"cardExpiry"` // 账号卡到期时间

	// Codex 中转(API 卡密)模式:不租号、不要 card,用本地配置的 key 直连第三方
	// 中转站。CodexMode=="relay" 且 base/key 齐全时启用;否则走原有号池/租号流程。
	CodexMode          string            `json:"codexMode"`          // "" / "rental" (默认) 或 "relay"
	CodexRelayBase     string            `json:"codexRelayBase"`     // 中转站基址,请求落在 {base}/responses 或 /chat/completions
	CodexRelayKey      string            `json:"codexRelayKey"`      // 中转卡密(Authorization: Bearer)
	CodexRelayProtocol string            `json:"codexRelayProtocol"` // "" / "responses" (默认) 或 "chat"(通用 OpenAI 中转)
	CodexModelMap      map[string]string `json:"codexModelMap"`      // 可选:客户端模型名 → 中转模型名
}

var (
	configLock sync.RWMutex
)

func getAppDataDir() string {
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
		AccountCard:   "",
		DeviceId:      "",
		ProxyPort:     DefaultProxyPort,
		UpstreamProxy: "",
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

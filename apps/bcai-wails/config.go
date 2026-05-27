package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	AccountCard   string `json:"accountCard"`
	DeviceId      string `json:"deviceId"`
	ProxyPort     int    `json:"proxyPort"`
	UpstreamProxy string `json:"upstreamProxy"`
	IDEPath       string `json:"idePath"`       // 用户自定义 IDE 安装路径（留空则自动检测）
	HubPath       string `json:"hubPath"`       // 用户自定义 Hub 安装路径（留空则自动检测）
	CardExpiry    string `json:"cardExpiry"`    // 账号卡到期时间
	PoolMode      string `json:"poolMode"`      // "remote" (默认, 使用卡密) 或 "local" (本地号池)
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
	if err := os.WriteFile(file, data, 0600); err != nil {
		return err
	}

	return nil
}

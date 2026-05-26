package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

type Config struct {
	AccountCard   string `json:"accountCard"`
	DeviceId      string `json:"deviceId"`
	ProxyPort     int    `json:"proxyPort"`
	UpstreamProxy string `json:"upstreamProxy"`
	CardExpiry    string `json:"cardExpiry"`
}

var (
	configLock sync.RWMutex
)

func getAppDataDir() string {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
	case "darwin":
		base = filepath.Join(os.Getenv("HOME"), "Library", "Application Support")
	default:
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "BingchaAI")
}

func configFilePath() string {
	return filepath.Join(getAppDataDir(), "proxy-config.json")
}

func DefaultConfig() Config {
	return Config{
		ProxyPort: DefaultProxyPort,
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

	return os.WriteFile(configFilePath(), data, 0600)
}

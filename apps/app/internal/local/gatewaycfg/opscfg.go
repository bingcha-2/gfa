package gatewaycfg

// opscfg 持久化反代网关的「运维参数」——对齐 cockpit codex_local_access 的
// updateTimeouts / updateTimeoutPresets / updateUpstreamProxyConfig,但只落地
// CLIProxyAPI config 真正支持的那部分:
//
//   - Timeouts:流式 keepalive 秒 / bootstrap 重试次数 / 最大重试凭证数 / 最大重试间隔秒。
//     这四项分别映射到 CLIProxyAPI 的 streaming.keepalive-seconds、
//     streaming.bootstrap-retries、max-retry-credentials、max-retry-interval。
//     cockpit 还有一堆 legacy_* / websocket_* 超时(见 models/codex_local_access.rs),
//     那些由 cockpit 自身 app 层 HTTP 客户端消费,CLIProxyAPI 无对应 config 字段,
//     故本地【不落地】(TODO:若将来需要要走深度 proxy 改造,不在本 wave)。
//   - TimeoutPresets:命名预设(id+name+一组 Timeouts),可切换 active。
//   - UpstreamProxyURL:出口代理(http/https/socks5[h]),映射 CLIProxyAPI proxy-url。
//
// 红线:这些参数只作用于 codex 自有号网关的数据面;与远程租号 / 出口凭证无关。

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const opsFileName = "gateway-ops.json"

// 默认值(与 cockpit 常用默认对齐;keepalive 关闭、无 bootstrap 重试、
// 重试凭证 0=试全部、重试间隔 0=用库默认)。
const (
	defaultStreamKeepaliveSeconds = 0
	defaultStreamBootstrapRetries = 0
	defaultMaxRetryCredentials    = 0
	defaultMaxRetryIntervalSec    = 0
)

// Timeouts 是网关运维超时/重试参数(只含 CLIProxyAPI 可落地的子集)。
type Timeouts struct {
	// StreamKeepaliveSeconds → streaming.keepalive-seconds;<=0 关闭心跳。
	StreamKeepaliveSeconds int `json:"streamKeepaliveSeconds"`
	// StreamBootstrapRetries → streaming.bootstrap-retries;首字节前的重试次数,<=0 关闭。
	StreamBootstrapRetries int `json:"streamBootstrapRetries"`
	// MaxRetryCredentials → max-retry-credentials;失败请求最多试几个凭证,0=试全部。
	MaxRetryCredentials int `json:"maxRetryCredentials"`
	// MaxRetryIntervalSeconds → max-retry-interval;重试冷却凭证前的最大等待秒。
	MaxRetryIntervalSeconds int `json:"maxRetryIntervalSeconds"`
}

// DefaultTimeouts 返回一组安全默认。
func DefaultTimeouts() Timeouts {
	return Timeouts{
		StreamKeepaliveSeconds:  defaultStreamKeepaliveSeconds,
		StreamBootstrapRetries:  defaultStreamBootstrapRetries,
		MaxRetryCredentials:     defaultMaxRetryCredentials,
		MaxRetryIntervalSeconds: defaultMaxRetryIntervalSec,
	}
}

// normalize 把非法(负)值夹到 0,返回归一后的副本。
func (t Timeouts) normalize() Timeouts {
	if t.StreamKeepaliveSeconds < 0 {
		t.StreamKeepaliveSeconds = 0
	}
	if t.StreamBootstrapRetries < 0 {
		t.StreamBootstrapRetries = 0
	}
	if t.MaxRetryCredentials < 0 {
		t.MaxRetryCredentials = 0
	}
	if t.MaxRetryIntervalSeconds < 0 {
		t.MaxRetryIntervalSeconds = 0
	}
	return t
}

// TimeoutPreset 是一组命名超时预设。
type TimeoutPreset struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Timeouts  Timeouts `json:"timeouts"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

// OpsConfig 是完整的运维参数快照(持久化 + 前端读写)。
type OpsConfig struct {
	Timeouts         Timeouts        `json:"timeouts"`
	TimeoutPresets   []TimeoutPreset `json:"timeoutPresets"`
	ActivePresetID   string          `json:"activePresetId"`
	UpstreamProxyURL string          `json:"upstreamProxyUrl"`
}

// DefaultOpsConfig 返回默认运维配置(空预设、无代理)。
func DefaultOpsConfig() OpsConfig {
	return OpsConfig{
		Timeouts:       DefaultTimeouts(),
		TimeoutPresets: []TimeoutPreset{},
	}
}

// OpsStore 持久化运维参数到一个小 JSON 文件。
type OpsStore struct {
	path string
	mu   sync.Mutex
}

// NewOpsStore 在 dir 下开一个运维参数 store。
func NewOpsStore(dir string) *OpsStore { return &OpsStore{path: filepath.Join(dir, opsFileName)} }

func (s *OpsStore) loadLocked() OpsConfig {
	cfg := DefaultOpsConfig()
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if cfg.TimeoutPresets == nil {
		cfg.TimeoutPresets = []TimeoutPreset{}
	}
	cfg.Timeouts = cfg.Timeouts.normalize()
	return cfg
}

func (s *OpsStore) saveLocked(cfg OpsConfig) error {
	if cfg.TimeoutPresets == nil {
		cfg.TimeoutPresets = []TimeoutPreset{}
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load 读取整份运维配置;缺省/损坏回退默认。
func (s *OpsStore) Load() OpsConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

// SaveTimeouts 校验并持久化「当前生效超时」,返回归一后的配置。
func (s *OpsStore) SaveTimeouts(t Timeouts) (OpsConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.loadLocked()
	cfg.Timeouts = t.normalize()
	if err := s.saveLocked(cfg); err != nil {
		return OpsConfig{}, err
	}
	return cfg, nil
}

// SavePresets 整体替换预设列表(前端整表编辑用)。为缺失时间戳补当前时刻。
func (s *OpsStore) SavePresets(presets []TimeoutPreset) (OpsConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.loadLocked()
	now := time.Now().UnixMilli()
	out := make([]TimeoutPreset, 0, len(presets))
	for _, p := range presets {
		p.Name = strings.TrimSpace(p.Name)
		if p.ID == "" || p.Name == "" {
			return OpsConfig{}, errors.New("gatewaycfg: 预设需要 id 与 name")
		}
		if p.CreatedAt == 0 {
			p.CreatedAt = now
		}
		p.UpdatedAt = now
		p.Timeouts = p.Timeouts.normalize()
		out = append(out, p)
	}
	cfg.TimeoutPresets = out
	// active 预设被删则清空。
	if cfg.ActivePresetID != "" && findPreset(out, cfg.ActivePresetID) == nil {
		cfg.ActivePresetID = ""
	}
	if err := s.saveLocked(cfg); err != nil {
		return OpsConfig{}, err
	}
	return cfg, nil
}

// ActivatePreset 把某预设的超时设为当前生效,并记录 activePresetId。
func (s *OpsStore) ActivatePreset(id string) (OpsConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.loadLocked()
	p := findPreset(cfg.TimeoutPresets, id)
	if p == nil {
		return OpsConfig{}, errors.New("gatewaycfg: 预设不存在")
	}
	cfg.Timeouts = p.Timeouts.normalize()
	cfg.ActivePresetID = id
	if err := s.saveLocked(cfg); err != nil {
		return OpsConfig{}, err
	}
	return cfg, nil
}

// SaveUpstreamProxy 校验并持久化出口代理 URL(空=直连)。返回归一后的配置。
func (s *OpsStore) SaveUpstreamProxy(raw string) (OpsConfig, error) {
	proxyURL, err := NormalizeProxyURL(raw)
	if err != nil {
		return OpsConfig{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.loadLocked()
	cfg.UpstreamProxyURL = proxyURL
	if err := s.saveLocked(cfg); err != nil {
		return OpsConfig{}, err
	}
	return cfg, nil
}

func findPreset(presets []TimeoutPreset, id string) *TimeoutPreset {
	for i := range presets {
		if presets[i].ID == id {
			return &presets[i]
		}
	}
	return nil
}

// NormalizeProxyURL 校验出口代理 URL:空串合法(=直连);否则要求 scheme 为
// http/https/socks5/socks5h 且含 host(与 CLIProxyAPI proxyutil 支持的一致)。
func NormalizeProxyURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", errors.New("gatewaycfg: 代理 URL 解析失败")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
	default:
		return "", errors.New("gatewaycfg: 代理 scheme 需为 http/https/socks5/socks5h")
	}
	if u.Host == "" {
		return "", errors.New("gatewaycfg: 代理 URL 缺少 host")
	}
	return s, nil
}

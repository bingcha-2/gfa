// Package refreshcfg 持久化「自动刷新间隔」配置(分钟),对齐截图:
//   - QuotaMinutes:配额自动刷新间隔(默认 10)
//   - CurrentMinutes:当前账号刷新间隔(默认 1)
package refreshcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const (
	defaultQuotaMinutes   = 10
	defaultCurrentMinutes = 1
	fileName              = "refresh-config.json"
)

// Config 是自动刷新间隔(分钟)。
type Config struct {
	QuotaMinutes   int `json:"quotaMinutes"`
	CurrentMinutes int `json:"currentMinutes"`
}

type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// Load 读取配置;缺省/损坏/非正值则回退默认。
func (s *Store) Load() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := Config{QuotaMinutes: defaultQuotaMinutes, CurrentMinutes: defaultCurrentMinutes}
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &c)
	}
	return clamp(c)
}

func (s *Store) Save(c Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c = clamp(c)
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func clamp(c Config) Config {
	if c.QuotaMinutes <= 0 {
		c.QuotaMinutes = defaultQuotaMinutes
	}
	if c.CurrentMinutes <= 0 {
		c.CurrentMinutes = defaultCurrentMinutes
	}
	return c
}

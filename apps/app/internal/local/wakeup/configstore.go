package wakeup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ConfigStore 持久化某 provider 的 wakeup 配置到一个小 JSON 文件。
type ConfigStore struct {
	path string
	mu   sync.Mutex
}

func NewConfigStore(dir, provider string) *ConfigStore {
	return &ConfigStore{path: filepath.Join(dir, "wakeup-"+provider+".json")}
}

// Load 读取配置;缺省/损坏则返回默认(未启用,默认间隔)。
func (s *ConfigStore) Load() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := Config{IntervalMinutes: defaultIntervalMin}
	data, err := os.ReadFile(s.path)
	if err == nil {
		_ = json.Unmarshal(data, &c)
	}
	if c.IntervalMinutes <= 0 {
		c.IntervalMinutes = defaultIntervalMin
	}
	return c
}

func (s *ConfigStore) Save(c Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.IntervalMinutes <= 0 {
		c.IntervalMinutes = defaultIntervalMin
	}
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

package takeover

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// SourceStore 持久化每产品的号源(remote|local)到一个小 JSON 文件,
// 以便重启后知道某产品当前按哪种模式接管。默认 remote(保持现状行为)。
type SourceStore struct {
	path string
	mu   sync.Mutex
}

func NewSourceStore(dir string) *SourceStore {
	return &SourceStore{path: filepath.Join(dir, "sources.json")}
}

func (s *SourceStore) load() map[string]string {
	m := map[string]string{}
	data, err := os.ReadFile(s.path)
	if err == nil {
		_ = json.Unmarshal(data, &m)
	}
	return m
}

func (s *SourceStore) Get(product string) AccountSource {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.load()
	return Normalize(m[product])
}

func (s *SourceStore) Set(product string, src AccountSource) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.load()
	m[product] = string(src)
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

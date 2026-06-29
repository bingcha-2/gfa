// Package instance 管理本地多实例 profile(每实例独立 user-data-dir + 绑定账号)。
// 本包只管 profile 的持久化与 CRUD;实际启动/停止真实 app(进程隔离)属平台集成,
// 需真机验证,不在本包。
package instance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Profile 一个隔离实例的配置。
type Profile struct {
	ID             string `json:"id"`
	Provider       string `json:"provider"` // codex | antigravity
	Name           string `json:"name"`
	UserDataDir    string `json:"userDataDir"`
	WorkingDir     string `json:"workingDir,omitempty"`
	ExtraArgs      string `json:"extraArgs,omitempty"`
	BindAccountID  string `json:"bindAccountId,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	LastLaunchedAt int64  `json:"lastLaunchedAt,omitempty"`
	Pid            int    `json:"pid,omitempty"` // >0 表示运行中(由启动层维护)
}

type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store {
	return &Store{path: filepath.Join(dir, "instances.json")}
}

func (s *Store) load() []*Profile {
	var list []*Profile
	data, err := os.ReadFile(s.path)
	if err == nil {
		_ = json.Unmarshal(data, &list)
	}
	return list
}

func (s *Store) save(list []*Profile) error {
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Create 新建 profile(分配 id + createdAt)。
func (s *Store) Create(p *Profile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.ID == "" {
		p.ID = uuid.NewString()
	}
	if p.CreatedAt == 0 {
		p.CreatedAt = time.Now().UnixMilli()
	}
	list := append(s.load(), p)
	return s.save(list)
}

func (s *Store) List(provider string) ([]*Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.load()
	out := make([]*Profile, 0, len(all))
	for _, p := range all {
		if provider == "" || p.Provider == provider {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

func (s *Store) Get(id string) (*Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.load() {
		if p.ID == id {
			return p, true
		}
	}
	return nil, false
}

// Update 覆盖同 id 的 profile(保留 createdAt)。
func (s *Store) Update(p *Profile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.load()
	for i, x := range list {
		if x.ID == p.ID {
			if p.CreatedAt == 0 {
				p.CreatedAt = x.CreatedAt
			}
			list[i] = p
			return s.save(list)
		}
	}
	return s.save(append(list, p))
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.load()
	out := list[:0]
	for _, p := range list {
		if p.ID != id {
			out = append(out, p)
		}
	}
	return s.save(out)
}

// SetPid 标记运行状态(启动层调用;pid=0 表示已停)。
func (s *Store) SetPid(id string, pid int) error {
	p, ok := s.Get(id)
	if !ok {
		return os.ErrNotExist
	}
	if pid > 0 {
		p.LastLaunchedAt = time.Now().UnixMilli()
	}
	p.Pid = pid
	return s.Update(p)
}

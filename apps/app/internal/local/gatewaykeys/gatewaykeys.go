// Package gatewaykeys 持久化反代网关对 /v1 客户端的「访问 key」列表。
//
// 这些 key 写进 CLIProxyAPI 的 api-keys(见 gateway.SetAPIKeys),客户端调用本地
// 网关时需带其一。对齐 cockpit codex_local_access 的 api_key 管理(名称+值+创建时间)。
//
// 红线:这些是【客户端访问网关】的 key,与远程租号/出口凭证无关。
package gatewaykeys

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const fileName = "gateway-keys.json"

// Key 是一条客户端访问 key(名称 + 值 + 创建时刻)。
type Key struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Value     string `json:"value"`
	CreatedAt int64  `json:"createdAt"` // unix 毫秒
}

// Store 持久化 key 列表到一个小 JSON 文件(保序)。
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

func (s *Store) load() []Key {
	var keys []Key
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &keys)
	}
	return keys
}

func (s *Store) save(keys []Key) error {
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// List 返回所有 key(按创建顺序)。
func (s *Store) List() []Key {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Values 返回所有 key 的值(写网关 api-keys 用)。
func (s *Store) Values() []string {
	keys := s.List()
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k.Value)
	}
	return out
}

// Create 生成并追加一条新 key。
func (s *Store) Create(name string) (Key, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	val, err := genValue()
	if err != nil {
		return Key{}, err
	}
	now := time.Now().UnixMilli()
	k := Key{ID: genID(), Name: name, Value: val, CreatedAt: now}
	keys := append(s.load(), k)
	if err := s.save(keys); err != nil {
		return Key{}, err
	}
	return k, nil
}

// Delete 按 id 删除一条 key;不存在视为成功(幂等)。
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := s.load()
	out := keys[:0]
	for _, k := range keys {
		if k.ID != id {
			out = append(out, k)
		}
	}
	return s.save(out)
}

// Rotate 重置某 key 的值(保留 id/name/createdAt)。不存在返回错误。
func (s *Store) Rotate(id string) (Key, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := s.load()
	for i := range keys {
		if keys[i].ID == id {
			val, err := genValue()
			if err != nil {
				return Key{}, err
			}
			keys[i].Value = val
			if err := s.save(keys); err != nil {
				return Key{}, err
			}
			return keys[i], nil
		}
	}
	return Key{}, errors.New("gatewaykeys: key not found")
}

// genValue 生成一个 sk- 前缀的随机访问 key(32 字节熵)。
func genValue() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "sk-" + hex.EncodeToString(b), nil
}

// genID 生成一个随机短 id。
func genID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

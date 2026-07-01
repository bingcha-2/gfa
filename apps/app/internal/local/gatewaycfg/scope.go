// Package gatewaycfg 持久化反代网关的「局域网范围」(access scope):
//   - local(默认,安全):仅本机可访问(绑定 127.0.0.1)。
//   - lan:局域网可访问(绑定 0.0.0.0)。
//
// 安全:默认仅本机,避免无意把自有号网关暴露到局域网。
package gatewaycfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Scope 是网关访问范围枚举。
type Scope string

const (
	ScopeLocal Scope = "local" // 127.0.0.1
	ScopeLAN   Scope = "lan"   // 0.0.0.0

	defaultScope = ScopeLocal
	fileName     = "gateway-scope.json"
)

// Host 返回该范围对应的绑定主机。
func (s Scope) Host() string {
	if s == ScopeLAN {
		return "0.0.0.0"
	}
	return "127.0.0.1"
}

// Normalize 归一外部输入,未知/空回退默认(local)。
func Normalize(s string) Scope {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "lan", "0.0.0.0":
		return ScopeLAN
	case "local", "127.0.0.1", "":
		return ScopeLocal
	default:
		return defaultScope
	}
}

// IsKnown 报告外部输入是否对应一个已知范围(用于显式拒绝未知输入)。
func IsKnown(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "lan", "0.0.0.0", "local", "127.0.0.1":
		return true
	default:
		return false
	}
}

func valid(s Scope) bool { return s == ScopeLocal || s == ScopeLAN }

type fileModel struct {
	Scope Scope `json:"scope"`
}

// Store 持久化 scope 到一个小 JSON 文件。
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// Load 读取 scope;缺省/损坏/非法回退默认(local)。
func (s *Store) Load() Scope {
	s.mu.Lock()
	defer s.mu.Unlock()
	var m fileModel
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &m)
	}
	if !valid(m.Scope) {
		return defaultScope
	}
	return m.Scope
}

// Save 校验并持久化 scope。非法返回错误且不落盘。
func (s *Store) Save(scope Scope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !valid(scope) {
		return &os.PathError{Op: "save", Path: s.path, Err: errInvalidScope}
	}
	data, err := json.MarshalIndent(fileModel{Scope: scope}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

var errInvalidScope = errStr("gatewaycfg: invalid scope")

type errStr string

func (e errStr) Error() string { return string(e) }

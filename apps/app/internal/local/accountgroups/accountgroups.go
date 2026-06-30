// Package accountgroups 持久化「账号分组」(Group{id,name,accountIDs}) 列表,
// 并提供账号→分组的解析 helper。
//
// 直接照 cockpit 移植到 Go:对齐 cockpit 前端
// src/services/codexAccountGroupService.ts(磁盘文件 codex_account_groups.json):
//   - Group 结构 = {id, name, sortOrder, accountIds[], createdAt}
//   - List 按 sortOrder 升序;Create 取当前最大 sortOrder+1
//   - Assign 为独占语义:把账号加入目标分组前,先从其它分组移除(一个账号只属一个分组)
//   - CleanupDeletedAccounts:账号被删除时剔除游离 ID
// 落盘为 JSON 数组(camelCase 键),原子写(临时文件 + rename)。
//
// 红线:本包自包含、可独立 go test;只读写本地分组文件,
// 与远程租号 / proxy.go / 网关出口完全无关。
package accountgroups

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const fileName = "codex_account_groups.json"

// Group 是一个账号分组。JSON 标签为 camelCase,对齐 cockpit 磁盘格式。
type Group struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	SortOrder  int      `json:"sortOrder"`
	AccountIDs []string `json:"accountIds"`
	CreatedAt  int64    `json:"createdAt"`
}

var idCounter uint64

func generateID() string {
	return fmt.Sprintf("cgrp_%d_%d", time.Now().UnixMilli(), atomic.AddUint64(&idCounter, 1))
}

// Store 把分组列表落到 dir/codex_account_groups.json(原子写)。
// 所有读改写操作在内部串行,保证文件一致性。
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore 在 dir 下打开/创建分组存储。
func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// Load 读取分组列表;缺省/损坏回退空列表(永不返回 nil 元素的脏数据)。
func (s *Store) Load() ([]Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() ([]Group, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Group{}, nil
		}
		return nil, err
	}
	var groups []Group
	if err := json.Unmarshal(data, &groups); err != nil {
		// 损坏文件回退空列表(对齐 cockpit catch→[])
		return []Group{}, nil
	}
	for i := range groups {
		if groups[i].AccountIDs == nil {
			groups[i].AccountIDs = []string{}
		}
	}
	return groups, nil
}

// Save 原子写入分组列表(JSON 数组)。
func (s *Store) Save(groups []Group) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(groups)
}

func (s *Store) saveLocked(groups []Group) error {
	if groups == nil {
		groups = []Group{}
	}
	data, err := json.MarshalIndent(groups, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, data, 0o600)
}

// List 返回按 sortOrder 升序排序的分组列表。
func (s *Store) List() ([]Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(groups, func(i, j int) bool { return groups[i].SortOrder < groups[j].SortOrder })
	return groups, nil
}

// Create 新建分组,sortOrder 取当前最大值 +1。name 去首尾空白。
func (s *Store) Create(name string) (Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return Group{}, err
	}
	maxOrder := 0
	for _, g := range groups {
		if g.SortOrder > maxOrder {
			maxOrder = g.SortOrder
		}
	}
	g := Group{
		ID:         generateID(),
		Name:       strings.TrimSpace(name),
		SortOrder:  maxOrder + 1,
		AccountIDs: []string{},
		CreatedAt:  time.Now().UnixMilli(),
	}
	groups = append(groups, g)
	if err := s.saveLocked(groups); err != nil {
		return Group{}, err
	}
	return g, nil
}

// Rename 改名(去首尾空白)。分组不存在返回 (nil, nil)。
func (s *Store) Rename(groupID, name string) (*Group, error) {
	return s.mutateGroup(groupID, func(g *Group) { g.Name = strings.TrimSpace(name) })
}

// UpdateSortOrder 更新排序值。分组不存在返回 (nil, nil)。
func (s *Store) UpdateSortOrder(groupID string, sortOrder int) (*Group, error) {
	return s.mutateGroup(groupID, func(g *Group) { g.SortOrder = sortOrder })
}

// Delete 删除分组(不存在为 no-op)。
func (s *Store) Delete(groupID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return err
	}
	out := groups[:0]
	for _, g := range groups {
		if g.ID != groupID {
			out = append(out, g)
		}
	}
	return s.saveLocked(out)
}

// Assign 把 accountIDs 加入目标分组(独占):先从其它分组移除,再追加去重。
// 分组不存在返回 (nil, nil)。
func (s *Store) Assign(groupID string, accountIDs []string) (*Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	idx := indexOf(groups, groupID)
	if idx < 0 {
		return nil, nil
	}
	target := make(map[string]bool, len(accountIDs))
	for _, id := range accountIDs {
		target[id] = true
	}
	// 从其它分组移除
	for i := range groups {
		if groups[i].ID == groupID {
			continue
		}
		groups[i].AccountIDs = filterOut(groups[i].AccountIDs, target)
	}
	// 追加到目标分组(去重)
	existing := make(map[string]bool, len(groups[idx].AccountIDs))
	for _, id := range groups[idx].AccountIDs {
		existing[id] = true
	}
	for _, id := range accountIDs {
		if !existing[id] {
			groups[idx].AccountIDs = append(groups[idx].AccountIDs, id)
			existing[id] = true
		}
	}
	if err := s.saveLocked(groups); err != nil {
		return nil, err
	}
	g := groups[idx]
	return &g, nil
}

// RemoveAccounts 从分组移除指定账号。分组不存在返回 (nil, nil)。
func (s *Store) RemoveAccounts(groupID string, accountIDs []string) (*Group, error) {
	toRemove := make(map[string]bool, len(accountIDs))
	for _, id := range accountIDs {
		toRemove[id] = true
	}
	return s.mutateGroup(groupID, func(g *Group) {
		g.AccountIDs = filterOut(g.AccountIDs, toRemove)
	})
}

// CleanupDeletedAccounts 剔除不在 existing 中的账号 ID(账号被删除时调用)。
func (s *Store) CleanupDeletedAccounts(existing map[string]bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return err
	}
	changed := false
	for i := range groups {
		before := len(groups[i].AccountIDs)
		kept := groups[i].AccountIDs[:0]
		for _, id := range groups[i].AccountIDs {
			if existing[id] {
				kept = append(kept, id)
			}
		}
		groups[i].AccountIDs = kept
		if len(kept) != before {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.saveLocked(groups)
}

// mutateGroup 对指定分组应用 fn 后落盘;分组不存在返回 (nil, nil)。
func (s *Store) mutateGroup(groupID string, fn func(*Group)) (*Group, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	groups, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	idx := indexOf(groups, groupID)
	if idx < 0 {
		return nil, nil
	}
	fn(&groups[idx])
	if err := s.saveLocked(groups); err != nil {
		return nil, err
	}
	g := groups[idx]
	return &g, nil
}

// GroupOfAccount 返回包含 accountID 的分组 ID(不存在返回 "")。
func GroupOfAccount(groups []Group, accountID string) string {
	for _, g := range groups {
		for _, id := range g.AccountIDs {
			if id == accountID {
				return g.ID
			}
		}
	}
	return ""
}

// ResolveAccountGroups 构建 accountID→groupID 的映射(每个账号独占一组)。
func ResolveAccountGroups(groups []Group) map[string]string {
	out := make(map[string]string)
	for _, g := range groups {
		for _, id := range g.AccountIDs {
			out[id] = g.ID
		}
	}
	return out
}

func indexOf(groups []Group, groupID string) int {
	for i := range groups {
		if groups[i].ID == groupID {
			return i
		}
	}
	return -1
}

func filterOut(ids []string, remove map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !remove[id] {
			out = append(out, id)
		}
	}
	return out
}

// writeFileAtomic 写临时文件后 rename,避免半截写入。
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

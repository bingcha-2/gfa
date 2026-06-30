// Package aghistory 直接照 cockpit 移植「Antigravity 切换历史 + 已装版本信息」到 Go。
//
// 切换历史移植自 cockpit crates/cockpit-core/src/modules/antigravity_switch_history.rs:
//   - load_history -> Store.Load:缺省/空文件/损坏一律返回空切片(容错,不报错)。
//   - add_history_item -> Store.Add:按 id 去重、按 timestamp 降序、截断到 200 条,原子落盘。
//   - clear_history -> Store.Clear:写空数组。
//
// 已装版本解析移植自 cockpit src-tauri/src/commands/system.rs 的
// read_antigravity_product_json_metadata / read_antigravity_macos_bundle_metadata:
//   - ParseProductJSON / ParsePlistDump 是纯函数,只吃内容、出 InstalledVersionInfo。
//   - ReadVersionFile 由调用方传入版本文件路径(product.json 或 plutil -p 输出),
//     不在本包做平台探测/子进程调用,保持可独立 go test。
//
// 红线:本包自包含、只读写本地切号历史 JSON 与解析版本文件,
// 与远程租号 / proxy.go / 网关出口完全无关。
package aghistory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	historyFile     = "antigravity_switch_history.json"
	maxHistoryItems = 200

	defaultTriggerType   = "manual"
	defaultTriggerSource = "tools.account.switch"
)

// AutoSwitchHitGroup 对齐 cockpit AntigravityAutoSwitchHitGroup。
type AutoSwitchHitGroup struct {
	GroupID    string `json:"groupId"`
	GroupName  string `json:"groupName"`
	Percentage int    `json:"percentage"`
}

// AutoSwitchReason 对齐 cockpit AntigravityAutoSwitchReason(自动切号命中详情)。
type AutoSwitchReason struct {
	Rule               string               `json:"rule"`
	Threshold          int                  `json:"threshold"`
	ScopeMode          string               `json:"scopeMode"`
	SelectedGroupIDs   []string             `json:"selectedGroupIds,omitempty"`
	SelectedGroupNames []string             `json:"selectedGroupNames,omitempty"`
	HitGroups          []AutoSwitchHitGroup `json:"hitGroups,omitempty"`
	CandidateCount     int                  `json:"candidateCount"`
	SelectedPolicy     string               `json:"selectedPolicy"`
}

// SwitchHistoryItem 对齐 cockpit AntigravitySwitchHistoryItem。JSON 标签为 camelCase。
// 指针/omitempty 字段对应 Rust 的 Option<T>。
type SwitchHistoryItem struct {
	ID                    string            `json:"id"`
	Timestamp             int64             `json:"timestamp"`
	AccountID             string            `json:"accountId"`
	TargetEmail           string            `json:"targetEmail"`
	TriggerType           string            `json:"triggerType"`
	TriggerSource         string            `json:"triggerSource"`
	LocalOK               bool              `json:"localOk"`
	SeamlessOK            bool              `json:"seamlessOk"`
	Success               bool              `json:"success"`
	LocalDurationMs       uint64            `json:"localDurationMs"`
	SeamlessDurationMs    *uint64           `json:"seamlessDurationMs,omitempty"`
	TotalDurationMs       uint64            `json:"totalDurationMs"`
	ErrorStage            *string           `json:"errorStage,omitempty"`
	ErrorCode             *string           `json:"errorCode,omitempty"`
	ErrorMessage          *string           `json:"errorMessage,omitempty"`
	SeamlessEffectiveMode *string           `json:"seamlessEffectiveMode,omitempty"`
	SeamlessFromEmail     *string           `json:"seamlessFromEmail,omitempty"`
	SeamlessToEmail       *string           `json:"seamlessToEmail,omitempty"`
	SeamlessExecutionID   *string           `json:"seamlessExecutionId,omitempty"`
	SeamlessFinishedAt    *string           `json:"seamlessFinishedAt,omitempty"`
	AutoSwitchReason      *AutoSwitchReason `json:"autoSwitchReason,omitempty"`
}

// Store 把切号历史落到 dir/antigravity_switch_history.json(原子写)。
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore 在 dir 下打开/创建历史存储。
func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, historyFile)} }

// Load 读取历史;缺省/空文件/解析失败一律返回空切片(对齐 cockpit 的容错语义,不报错)。
func (s *Store) Load() ([]SwitchHistoryItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() ([]SwitchHistoryItem, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []SwitchHistoryItem{}, nil
		}
		return nil, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return []SwitchHistoryItem{}, nil
	}
	var items []SwitchHistoryItem
	if err := json.Unmarshal(data, &items); err != nil {
		// 解析失败:容错回退空记录(cockpit 会隔离损坏文件,本包从简只回退)。
		return []SwitchHistoryItem{}, nil
	}
	return items, nil
}

// Add 追加一条记录:按 id 去重、按 timestamp 降序、截断到 maxHistoryItems,原子落盘。
// trigger_type / trigger_source 为空时回填 cockpit 默认值。
func (s *Store) Add(item SwitchHistoryItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.TrimSpace(item.TriggerType) == "" {
		item.TriggerType = defaultTriggerType
	}
	if strings.TrimSpace(item.TriggerSource) == "" {
		item.TriggerSource = defaultTriggerSource
	}

	existing, _ := s.loadLocked()
	filtered := existing[:0]
	for _, x := range existing {
		if x.ID != item.ID {
			filtered = append(filtered, x)
		}
	}
	filtered = append(filtered, item)
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].Timestamp > filtered[j].Timestamp
	})
	if len(filtered) > maxHistoryItems {
		filtered = filtered[:maxHistoryItems]
	}
	return s.saveLocked(filtered)
}

// Clear 清空历史(写空数组)。
func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked([]SwitchHistoryItem{})
}

func (s *Store) saveLocked(items []SwitchHistoryItem) error {
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, data, 0o600)
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

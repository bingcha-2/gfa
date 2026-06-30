// Package codexsettings 持久化「Codex 设置」面板的本地配置 + 读写 ~/.codex/config.toml
// 的快捷项(model_context_window / model_auto_compact_token_limit)。
//
// 直接照 cockpit 移植到 Go:
//   - 设置项对齐 cockpit crates/cockpit-core/src/modules/config.rs 的
//     codex_app_path / codex_launch_on_switch / codex_restart_specified_app_on_switch /
//     codex_specified_app_path / codex_local_access_entry_visible,以及前端 localStorage
//     的 filterMemory / showCodeReviewQuota(本端统一收进后端 Settings)。
//   - QuickConfig 对齐 codex_account.rs 的 read/write_quick_config_to_config_toml,
//     用 CodexHomeDir() 定位 ~/.codex,结构保留地改写两个顶层整数键,原子落盘。
//
// 红线:本包自包含、可独立 go test;只读写本地 Codex 设置与 config.toml,
// 与远程租号 / proxy.go / 网关出口完全无关。
package codexsettings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const fileName = "codex-settings.json"

// Settings 是「Codex 设置」面板的全部持久化项。JSON 标签为 camelCase。
type Settings struct {
	// CodexAppPath:Codex 启动路径(为空则用平台默认)。
	CodexAppPath string `json:"codexAppPath"`
	// LaunchOnSwitch:切换 Codex 账号后是否自动启动/重启 Codex App。
	LaunchOnSwitch bool `json:"launchOnSwitch"`
	// RestartAppOnSwitch:切号后是否联动重启指定应用。
	RestartAppOnSwitch bool `json:"restartAppOnSwitch"`
	// RestartAppPath:联动重启的指定应用路径。
	RestartAppPath string `json:"restartAppPath"`
	// ShowApiEntry:是否在 Codex 总览显示「本地 API 服务入口」。
	ShowApiEntry bool `json:"showApiEntry"`
	// FilterMemory:是否记忆账号列表的筛选条件。
	FilterMemory bool `json:"filterMemory"`
	// ShowCodeReviewQuota:是否显示 Code Review 配额。
	ShowCodeReviewQuota bool `json:"showCodeReviewQuota"`
}

// DefaultSettings 返回与 cockpit 默认值一致的设置。
//   - LaunchOnSwitch=true、ShowApiEntry=true(对齐 default_codex_launch_on_switch /
//     default_codex_local_access_entry_visible)。
//   - RestartAppOnSwitch=false、FilterMemory=false、ShowCodeReviewQuota=false。
func DefaultSettings() Settings {
	return Settings{
		CodexAppPath:        "",
		LaunchOnSwitch:      true,
		RestartAppOnSwitch:  false,
		RestartAppPath:      "",
		ShowApiEntry:        true,
		FilterMemory:        false,
		ShowCodeReviewQuota: false,
	}
}

// Store 把 Settings 落到 dir/codex-settings.json(原子写)。
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore 在 dir 下打开/创建设置存储。
func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// Load 读取设置;缺省/损坏回退默认。文件只覆盖出现的键(其余保留默认)。
func (s *Store) Load() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := DefaultSettings()
	data, err := os.ReadFile(s.path)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(data, &out)
	return out
}

// Save 原子写入设置。
func (s *Store) Save(in Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(in, "", "  ")
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

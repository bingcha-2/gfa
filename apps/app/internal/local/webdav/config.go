// Package webdav 实现「本地接管中心」的 WebDAV 同步:把一个备份 bundle 经
// 基础认证(Basic Auth)PUT/GET 到任意 WebDAV 服务端(坚果云 / Nextcloud 等),
// 并持久化连接配置(url/user/pass/远端目录)。
//
// 直接照 cockpit 移植到 Go:
//   - 连接配置与归一化对齐 cockpit-tools/src-tauri/src/modules/webdav_sync.rs 的
//     WebdavConnectionSettings + normalize_base_url / normalize_remote_dir。
//   - 上传/下载对齐 upload_backup_bytes(PUT)/ read_remote_backup_bytes(GET),
//     用 Basic Auth;上传前确保远端目录存在(MKCOL,幂等)。
//
// 红线(本任务硬约束):本包自包含、可独立 go test;HTTP 经注入的 http.Client
// 走业务 WebDAV 服务端,与远程租号 / proxy.go / 本地网关出口完全无关——绝不复用
// 租号数据面。文件 IO 全部落在调用方给的 dir(单测用临时目录)。
package webdav

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const configFileName = "webdav-sync.json"

// Config 是 WebDAV 同步面板的全部持久化项(JSON camelCase)。
// 含明文应用密码,落盘强制 0600。
type Config struct {
	Enabled   bool   `json:"enabled"`
	URL       string `json:"url"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	RemoteDir string `json:"remoteDir"`
}

// DefaultConfig 返回未配置时的默认值(全空、未启用)。
func DefaultConfig() Config { return Config{} }

// ConfigStore 把 Config 落到 dir/webdav-sync.json(原子写,0600)。
type ConfigStore struct {
	path string
	mu   sync.Mutex
}

// NewConfigStore 在 dir 下打开/创建配置存储。
func NewConfigStore(dir string) *ConfigStore {
	return &ConfigStore{path: filepath.Join(dir, configFileName)}
}

// Load 读取配置;缺省/损坏回退默认。文件只覆盖出现的键(其余保留默认)。
func (s *ConfigStore) Load() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := DefaultConfig()
	data, err := os.ReadFile(s.path)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(data, &out)
	return out
}

// Save 原子写入配置(含密码,0600)。
func (s *ConfigStore) Save(in Config) error {
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

// NormalizeBaseURL 归一化 WebDAV 根地址:去空白、强制 http/https、清掉 query/fragment、
// 末尾补 '/'。对齐 cockpit normalize_base_url。
func NormalizeBaseURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errEmptyURL
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", &Error{Op: "normalize_url", Msg: "WebDAV 地址无效: " + err.Error()}
	}
	switch u.Scheme {
	case "http", "https":
	default:
		return "", errBadScheme
	}
	u.RawQuery = ""
	u.Fragment = ""
	out := u.String()
	if !strings.HasSuffix(out, "/") {
		out += "/"
	}
	return out, nil
}

// NormalizeRemoteDir 归一化远端目录:去首尾 '/' 与空白、禁反斜杠、禁空段、禁 . / ..
// 路径穿越。对齐 cockpit normalize_remote_dir。
func NormalizeRemoteDir(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errEmptyRemoteDir
	}
	if strings.Contains(trimmed, "\\") {
		return "", errRemoteDirBackslash
	}
	parts := strings.Split(trimmed, "/")
	for _, p := range parts {
		seg := strings.TrimSpace(p)
		if seg == "" {
			return "", errRemoteDirEmptySegment
		}
		if seg == "." || seg == ".." {
			return "", errRemoteDirTraversal
		}
		if seg != p {
			return "", errRemoteDirEmptySegment
		}
	}
	return strings.Join(parts, "/"), nil
}

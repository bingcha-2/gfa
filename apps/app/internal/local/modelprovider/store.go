// Package modelprovider 持久化「codex 自定义模型供应商」+ 动态模型目录,
// 直接照 cockpit crates/cockpit-core/src/modules/codex_model_provider.rs 移植到 Go。
//
// 这是「自定义 OpenAI 兼容供应商」(非官方租号),用于喂给本地 codex 网关 /
// codex CLI 的 model_providers。与远程租号路径完全无关(红线:不碰 proxy.go)。
//
// 持久化语义(对齐 cockpit CODEX_MODEL_PROVIDERS_FILE = codex_model_providers.json):
//   - 一个 JSON 数组落在 dir/codex-model-providers.json
//   - 每条记录:id/name/baseURL/apiKey/wireApi(openai|responses)/modelCatalog/createdAt
//   - wireApi 留空时按 baseURL 启发式归一(见 NormalizeWireAPI)
package modelprovider

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const fileName = "codex-model-providers.json"

// WireAPI 是供应商的协议线格式。
//   - WireResponses:OpenAI Responses API(codex 原生,gpt-5 系)
//   - WireChatCompletions:OpenAI /chat/completions 兼容(deepseek/kimi/...)
type WireAPI string

const (
	WireResponses       WireAPI = "responses"
	WireChatCompletions WireAPI = "chat_completions"
)

// Provider 是一个自定义模型供应商记录。字段 JSON 标签对齐 cockpit camelCase。
type Provider struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	BaseURL      string   `json:"baseURL"`
	APIKey       string   `json:"apiKey"`
	WireAPI      WireAPI  `json:"wireApi"`
	ModelCatalog []string `json:"modelCatalog"`
	CreatedAt    int64    `json:"createdAt"` // Unix 毫秒
}

// Store 持久化供应商数组到一个 JSON 文件(原子写)。
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore 在 dir 下打开/创建供应商存储。
func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// List 返回全部供应商(按 createdAt 升序;损坏/缺省回退空)。
func (s *Store) List() []Provider {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

// Get 按 id 返回供应商;不存在返回 ok=false。
func (s *Store) Get(id string) (Provider, bool) {
	id = strings.TrimSpace(id)
	for _, p := range s.List() {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Save 新增或更新一条供应商(按 id upsert)。
// id 为空时生成新 id;name/baseURL 必填;wireApi 归一。返回落盘后的记录。
func (s *Store) Save(p Provider) (Provider, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.BaseURL = strings.TrimSpace(p.BaseURL)
	p.APIKey = strings.TrimSpace(p.APIKey)
	if p.Name == "" {
		return Provider{}, fmt.Errorf("modelprovider: 缺少名称")
	}
	if p.BaseURL == "" {
		return Provider{}, fmt.Errorf("modelprovider: 缺少 baseURL")
	}
	p.WireAPI = NormalizeWireAPI(string(p.WireAPI), p.BaseURL)
	p.ModelCatalog = cleanCatalog(p.ModelCatalog)

	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.readLocked()
	if p.ID = strings.TrimSpace(p.ID); p.ID == "" {
		p.ID = newID()
		p.CreatedAt = time.Now().UnixMilli()
		list = append(list, p)
	} else {
		found := false
		for i := range list {
			if list[i].ID == p.ID {
				if p.CreatedAt == 0 {
					p.CreatedAt = list[i].CreatedAt
				}
				list[i] = p
				found = true
				break
			}
		}
		if !found {
			if p.CreatedAt == 0 {
				p.CreatedAt = time.Now().UnixMilli()
			}
			list = append(list, p)
		}
	}
	if err := s.writeLocked(list); err != nil {
		return Provider{}, err
	}
	return p, nil
}

// Delete 按 id 删除一条供应商;不存在视为成功(幂等)。
func (s *Store) Delete(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("modelprovider: 缺少 id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.readLocked()
	out := list[:0:0]
	for _, p := range list {
		if p.ID != id {
			out = append(out, p)
		}
	}
	return s.writeLocked(out)
}

// SetModelCatalog 仅更新某供应商的模型目录(ListModels 回写用)。
func (s *Store) SetModelCatalog(id string, models []string) error {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.readLocked()
	for i := range list {
		if list[i].ID == id {
			list[i].ModelCatalog = cleanCatalog(models)
			return s.writeLocked(list)
		}
	}
	return fmt.Errorf("modelprovider: 供应商不存在: %s", id)
}

func (s *Store) readLocked() []Provider {
	var list []Provider
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &list)
	}
	for i := range list {
		list[i].WireAPI = NormalizeWireAPI(string(list[i].WireAPI), list[i].BaseURL)
		list[i].ModelCatalog = cleanCatalog(list[i].ModelCatalog)
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].CreatedAt < list[j].CreatedAt })
	return list
}

func (s *Store) writeLocked(list []Provider) error {
	if list == nil {
		list = []Provider{}
	}
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

func cleanCatalog(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		key := strings.ToLower(m)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, m)
	}
	return out
}

func newID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("mp-%d", time.Now().UnixNano())
	}
	return "mp-" + hex.EncodeToString(b[:])
}

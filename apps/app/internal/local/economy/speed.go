package economy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// 上下文与压缩阈值预设(照搬 QuickSettingsPopover.tsx 常量)。
const (
	contextWindow516K = 516000
	autoCompact516K   = 460000
	contextWindow1M   = 1000000
	autoCompact1M     = 900000
)

// service tier 取值(照搬 codex_speed.rs)。
const (
	serviceTierPriority = "priority"
	serviceTierFast     = "fast"
	serviceTierFlex     = "flex"
)

const speedConfigFile = "app-speed.json"

// ContextPreset 是上下文窗口/压缩阈值预设。
type ContextPreset string

const (
	PresetDefault ContextPreset = "default"
	Preset516K    ContextPreset = "preset_516k"
	Preset1M      ContextPreset = "preset_1m"
	PresetCustom  ContextPreset = "custom"
)

// ServiceTier 是官方 App 推理速度档(照搬 CodexAppSpeed:Fast=priority、Standard=默认/删键)。
type ServiceTier string

const (
	TierStandard ServiceTier = "standard"
	TierFast     ServiceTier = "fast"
)

// AppSpeed 是统一速度档配置:上下文预设(+ 自定义值)+ service tier。
type AppSpeed struct {
	ContextPreset       ContextPreset `json:"contextPreset"`
	Tier                ServiceTier   `json:"tier"`
	CustomContextWindow int64         `json:"customContextWindow,omitempty"`
	CustomAutoCompact   int64         `json:"customAutoCompact,omitempty"`
}

func i64ptr(v int64) *int64 { return &v }

// ResolveContextPreset 移植 resolveCodexQuickConfigPresetId:
// 由 config.toml 探测到的 model_context_window / model_auto_compact_token_limit 反推预设 id。
func ResolveContextPreset(modelContextWindow, autoCompactTokenLimit *int64) ContextPreset {
	if modelContextWindow == nil && autoCompactTokenLimit == nil {
		return PresetDefault
	}
	if modelContextWindow != nil && autoCompactTokenLimit != nil {
		if *modelContextWindow == contextWindow516K && *autoCompactTokenLimit == autoCompact516K {
			return Preset516K
		}
		if *modelContextWindow == contextWindow1M && *autoCompactTokenLimit == autoCompact1M {
			return Preset1M
		}
	}
	return PresetCustom
}

// PresetContextValues 返回某内置预设对应的 (model_context_window, model_auto_compact_token_limit)。
// nil 表示「删除该键」(default 预设);custom 不在此处理(用 AppSpeed.ContextValues)。
func PresetContextValues(p ContextPreset) (modelContextWindow, autoCompactTokenLimit *int64) {
	switch p {
	case Preset516K:
		return i64ptr(contextWindow516K), i64ptr(autoCompact516K)
	case Preset1M:
		return i64ptr(contextWindow1M), i64ptr(autoCompact1M)
	default: // PresetDefault / 未知 -> 清空
		return nil, nil
	}
}

// ContextValues 解析 AppSpeed 的最终上下文值:custom 用自定义值(非正则清空),其余走预设。
func (s AppSpeed) ContextValues() (modelContextWindow, autoCompactTokenLimit *int64) {
	if s.ContextPreset == PresetCustom {
		if s.CustomContextWindow > 0 {
			modelContextWindow = i64ptr(s.CustomContextWindow)
		}
		if s.CustomAutoCompact > 0 {
			autoCompactTokenLimit = i64ptr(s.CustomAutoCompact)
		}
		return modelContextWindow, autoCompactTokenLimit
	}
	return PresetContextValues(s.ContextPreset)
}

// ServiceTierValue 移植 codex_speed.rs 写 desktop.default-service-tier:
// Fast -> ("priority", true);Standard -> ("", false) 表示删除该键。
func ServiceTierValue(tier ServiceTier) (val string, set bool) {
	if tier == TierFast {
		return serviceTierPriority, true
	}
	return "", false
}

// NormalizeServiceTier 移植 normalize_service_tier_speed:fast/priority/flex -> Fast,其余 -> Standard。
func NormalizeServiceTier(raw string) ServiceTier {
	switch raw {
	case serviceTierFast, serviceTierPriority, serviceTierFlex:
		return TierFast
	default:
		return TierStandard
	}
}

// SpeedStore 持久化 AppSpeed(JSON 文件,原子写)。
type SpeedStore struct {
	path string
	mu   sync.Mutex
}

func NewSpeedStore(dir string) *SpeedStore {
	return &SpeedStore{path: filepath.Join(dir, speedConfigFile)}
}

func (s *SpeedStore) Load() AppSpeed {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := AppSpeed{ContextPreset: PresetDefault, Tier: TierStandard}
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &c)
	}
	if c.ContextPreset == "" {
		c.ContextPreset = PresetDefault
	}
	if c.Tier == "" {
		c.Tier = TierStandard
	}
	return c
}

func (s *SpeedStore) Save(c AppSpeed) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.ContextPreset == "" {
		c.ContextPreset = PresetDefault
	}
	if c.Tier == "" {
		c.Tier = TierStandard
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

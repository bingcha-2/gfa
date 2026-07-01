package economy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const (
	alertConfigFile          = "alert-config.json"
	defaultAlertThresholdPct = 20
)

// AlertConfig 是超额预警配置。ThresholdPct 为「剩余」百分比阈值(0..100):
// 当前号任一配额窗口剩余 <= 阈值即触发(照搬 cockpit metric_crossed_threshold)。
type AlertConfig struct {
	Enabled      bool `json:"enabled"`
	ThresholdPct int  `json:"thresholdPct"`
}

// AlertResult 是 ShouldAlert 的判定结果。
type AlertResult struct {
	Alert            bool
	LowestPercentage int      // 命中窗口里最低的剩余百分比
	LowModels        []string // 命中阈值的窗口 key(primary_window/secondary_window)
}

// ShouldAlert 移植 run_quota_alert_if_needed 的纯判定部分(去掉冷却节流与上游派发):
// 关闭/无配额则不报;否则任一窗口剩余 <= clamp(阈值) 即报。
func ShouldAlert(cfg AlertConfig, acc AccountView) AlertResult {
	if !cfg.Enabled {
		return AlertResult{}
	}
	threshold := clampPct(cfg.ThresholdPct)
	metrics := acc.quotaMetrics()
	if len(metrics) == 0 {
		return AlertResult{}
	}

	res := AlertResult{LowestPercentage: 101}
	for _, m := range metrics {
		if m.percentage <= threshold {
			res.Alert = true
			res.LowModels = append(res.LowModels, m.key)
			if m.percentage < res.LowestPercentage {
				res.LowestPercentage = m.percentage
			}
		}
	}
	if !res.Alert {
		return AlertResult{}
	}
	return res
}

// AlertStore 持久化 AlertConfig(JSON 文件,原子写),对齐 refreshcfg 约定。
type AlertStore struct {
	path string
	mu   sync.Mutex
}

func NewAlertStore(dir string) *AlertStore {
	return &AlertStore{path: filepath.Join(dir, alertConfigFile)}
}

// Load 读取配置;缺省/损坏回退默认(关闭 + 默认阈值),并裁剪阈值。
func (s *AlertStore) Load() AlertConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := AlertConfig{Enabled: false, ThresholdPct: defaultAlertThresholdPct}
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &c)
	}
	c.ThresholdPct = clampPct(c.ThresholdPct)
	return c
}

func (s *AlertStore) Save(c AlertConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.ThresholdPct = clampPct(c.ThresholdPct)
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

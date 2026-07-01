// Package routingcfg 持久化反代网关的「路由策略」(选号策略),对齐 cockpit
// codex_local_access 的 routing strategy。仅服务 codex 自有号网关。
//
// 策略(本地可测,语义见 authsync.Selector):
//   - priority(默认):优先号优先,否则第一个。保持现状行为。
//   - round-robin:在可用号间轮询。
//   - fair:按剩余额度高者优先(公平分摊)。
package routingcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Strategy 是路由策略枚举。
type Strategy string

const (
	StrategyPriority      Strategy = "priority"
	StrategyRoundRobin    Strategy = "round-robin"
	StrategyFair          Strategy = "fair"            // = cockpit quota_high_first
	StrategyQuotaLowFirst Strategy = "quota-low-first" // 先消耗剩余少的号(集中用尽)
	StrategyPlanHighFirst Strategy = "plan-high-first" // 高档套餐优先(cockpit auto 默认)
	StrategyPlanLowFirst  Strategy = "plan-low-first"  // 低档套餐优先(省高档)

	defaultStrategy = StrategyPriority
	fileName        = "routing-config.json"
)

// Normalize 把外部输入(可能是别名/空/未知)归一到合法策略,未知回退默认。
// 同时认 cockpit 的 snake_case 取值,便于跨端配置互通。
func Normalize(s string) Strategy {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "round-robin", "roundrobin", "rr":
		return StrategyRoundRobin
	case "fair", "quota-high-first", "quotahighfirst", "quota_high_first":
		return StrategyFair
	case "quota-low-first", "quotalowfirst", "quota_low_first":
		return StrategyQuotaLowFirst
	case "plan-high-first", "planhighfirst", "plan_high_first":
		return StrategyPlanHighFirst
	case "plan-low-first", "planlowfirst", "plan_low_first":
		return StrategyPlanLowFirst
	case "priority", "":
		return StrategyPriority
	default:
		return defaultStrategy
	}
}

// IsKnown 报告外部输入是否对应一个已知策略(用于显式拒绝未知输入,而非静默回退)。
func IsKnown(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "round-robin", "roundrobin", "rr",
		"fair", "quota-high-first", "quotahighfirst", "quota_high_first",
		"quota-low-first", "quotalowfirst", "quota_low_first",
		"plan-high-first", "planhighfirst", "plan_high_first",
		"plan-low-first", "planlowfirst", "plan_low_first",
		"priority":
		return true
	default:
		return false
	}
}

func valid(s Strategy) bool {
	switch s {
	case StrategyPriority, StrategyRoundRobin, StrategyFair,
		StrategyQuotaLowFirst, StrategyPlanHighFirst, StrategyPlanLowFirst:
		return true
	default:
		return false
	}
}

type fileModel struct {
	Strategy Strategy `json:"strategy"`
}

// Store 持久化路由策略到一个小 JSON 文件。
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, fileName)} }

// Load 读取策略;缺省/损坏/非法值回退默认(priority)。
func (s *Store) Load() Strategy {
	s.mu.Lock()
	defer s.mu.Unlock()
	var m fileModel
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &m)
	}
	if !valid(m.Strategy) {
		return defaultStrategy
	}
	return m.Strategy
}

// Save 校验并持久化策略。非法值返回错误且不落盘。
func (s *Store) Save(strategy Strategy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !valid(strategy) {
		return &os.PathError{Op: "save", Path: s.path, Err: errInvalidStrategy}
	}
	data, err := json.MarshalIndent(fileModel{Strategy: strategy}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// errInvalidStrategy 是非法策略的哨兵错误。
var errInvalidStrategy = errStr("routingcfg: invalid strategy")

type errStr string

func (e errStr) Error() string { return string(e) }

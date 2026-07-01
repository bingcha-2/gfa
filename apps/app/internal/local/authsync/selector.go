package authsync

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"

	"bcai-wails/internal/local/routingcfg"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

// Selector 实现 coreauth.Selector,按可配路由策略从进池自有号里选一个出口号。
// 策略语义对齐 cockpit codex_local_access 的 routing strategy:
//   - priority:优先号优先,否则第一个(保持历史行为)。
//   - round-robin:在可用号间轮询(按内部计数器回绕)。
//   - fair:剩余额度高者优先(Attributes["remaining_pct"],由 toAuth 注入)。
//
// 并发安全:Pick/SetStrategy 都在锁内(round-robin 计数器是可变状态)。
type Selector struct {
	mu       sync.Mutex
	strategy routingcfg.Strategy
	rr       uint64 // round-robin 游标
}

// NewSelector 用初始策略构建。
func NewSelector(s routingcfg.Strategy) *Selector {
	return &Selector{strategy: routingcfg.Normalize(string(s))}
}

// SetStrategy 热切换策略(改路由后立即对后续请求生效,无需重启网关)。
func (s *Selector) SetStrategy(strategy routingcfg.Strategy) {
	s.mu.Lock()
	s.strategy = routingcfg.Normalize(string(strategy))
	s.mu.Unlock()
}

func (s *Selector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	if len(auths) == 0 {
		return nil, errors.New("authsync: no available account")
	}
	s.mu.Lock()
	strategy := s.strategy
	switch strategy {
	case routingcfg.StrategyRoundRobin:
		idx := int(s.rr % uint64(len(auths)))
		s.rr++
		s.mu.Unlock()
		return auths[idx], nil
	default:
		s.mu.Unlock()
	}

	switch strategy {
	case routingcfg.StrategyFair:
		return pickFair(auths), nil
	case routingcfg.StrategyQuotaLowFirst:
		return pickQuotaLowFirst(auths), nil
	case routingcfg.StrategyPlanHighFirst:
		return pickPlanHighFirst(auths), nil
	case routingcfg.StrategyPlanLowFirst:
		return pickPlanLowFirst(auths), nil
	default: // priority
		return pickPriority(auths), nil
	}
}

// pickBest 返回首个「严格更优」者(平手保持输入顺序,稳定)。
func pickBest(auths []*coreauth.Auth, better func(a, b *coreauth.Auth) bool) *coreauth.Auth {
	best := auths[0]
	for _, a := range auths[1:] {
		if better(a, best) {
			best = a
		}
	}
	return best
}

// pickQuotaLowFirst 先用剩余额度少的号(集中用尽再换);平手时高档套餐优先。
// 未知额度(-1)不参与「先用尽」,视为最高,排到最后(对齐 cockpit nil-last)。
func pickQuotaLowFirst(auths []*coreauth.Auth) *coreauth.Auth {
	return pickBest(auths, func(a, b *coreauth.Auth) bool {
		qa, qb := remainingPctLowBias(a), remainingPctLowBias(b)
		if qa != qb {
			return qa < qb
		}
		return planRank(a) > planRank(b)
	})
}

// pickPlanHighFirst 高档套餐优先(cockpit auto 默认语义);平手时剩余额度高者优先。
func pickPlanHighFirst(auths []*coreauth.Auth) *coreauth.Auth {
	return pickBest(auths, func(a, b *coreauth.Auth) bool {
		ra, rb := planRank(a), planRank(b)
		if ra != rb {
			return ra > rb
		}
		return remainingPct(a) > remainingPct(b)
	})
}

// pickPlanLowFirst 低档套餐优先(省着高档号用);平手时剩余额度高者优先。
// 未知套餐不参与「先用低档」,视为最高档,排到最后。
func pickPlanLowFirst(auths []*coreauth.Auth) *coreauth.Auth {
	return pickBest(auths, func(a, b *coreauth.Auth) bool {
		ra, rb := planRankLowBias(a), planRankLowBias(b)
		if ra != rb {
			return ra < rb
		}
		return remainingPct(a) > remainingPct(b)
	})
}

// planRank 把套餐档位映射为可比整数(越大越高档);未知=0(最低)。
func planRank(a *coreauth.Auth) int {
	if a.Attributes == nil {
		return 0
	}
	switch strings.ToLower(strings.TrimSpace(a.Attributes["plan_type"])) {
	case "free":
		return 1
	case "plus":
		return 2
	case "pro":
		return 3
	case "team", "business":
		return 4
	case "enterprise", "edu", "enterprise_edu":
		return 5
	default:
		return 0
	}
}

// planRankLowBias 给「低档优先」用:未知套餐(0)记为最高档,避免被当成最低档先用掉。
func planRankLowBias(a *coreauth.Auth) int {
	if r := planRank(a); r > 0 {
		return r
	}
	return 100
}

// remainingPctLowBias 给「低额优先」用:未知额度(-1)记为最高,排到最后。
func remainingPctLowBias(a *coreauth.Auth) int {
	if p := remainingPct(a); p >= 0 {
		return p
	}
	return 101
}

// pickPriority 返回优先号(Attributes["priority"]=="1"),否则第一个。
func pickPriority(auths []*coreauth.Auth) *coreauth.Auth {
	for _, a := range auths {
		if a.Attributes["priority"] == "1" {
			return a
		}
	}
	return auths[0]
}

// pickFair 返回剩余额度最高者(平手保持原顺序);无额度信息退化为第一个。
func pickFair(auths []*coreauth.Auth) *coreauth.Auth {
	best := auths[0]
	bestPct := remainingPct(best)
	for _, a := range auths[1:] {
		if remainingPct(a) > bestPct {
			best, bestPct = a, remainingPct(a)
		}
	}
	return best
}

// remainingPct 从 Attributes 读剩余额度百分比(0-100);缺失/非法记为 -1(最低)。
func remainingPct(a *coreauth.Auth) int {
	if a.Attributes == nil {
		return -1
	}
	raw, ok := a.Attributes["remaining_pct"]
	if !ok {
		return -1
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return -1
	}
	return n
}

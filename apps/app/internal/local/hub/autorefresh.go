package hub

import (
	"context"
	"sync"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/refreshcfg"
)

// quotaRefresher 抽象「按 provider 刷全部 pool_enabled 号额度」,便于测试注入。
type quotaRefresher interface {
	RefreshAllQuotas(p account.Provider) (int, error)
}

// autoRefresher 后台 ticker:按「配额自动刷新」间隔(分钟)遍历两个 provider 刷额度。
// 间隔判定与 wakeup.Scheduler 同模式(lastRun + interval gate),便于改间隔即时生效。
type autoRefresher struct {
	target    quotaRefresher
	mu        sync.Mutex
	cfg       refreshcfg.Config
	lastRunMs int64
}

func newAutoRefresher(target quotaRefresher, cfg refreshcfg.Config) *autoRefresher {
	return &autoRefresher{target: target, cfg: cfg}
}

func (a *autoRefresher) setConfig(cfg refreshcfg.Config) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg = cfg
}

// dueAt 报告 now(unix ms)是否到了该刷一轮(距上轮 ≥ 配额刷新间隔)。
func (a *autoRefresher) dueAt(nowMs int64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	interval := a.cfg.QuotaMinutes
	if interval <= 0 {
		return false
	}
	return nowMs-a.lastRunMs >= int64(interval)*60_000
}

// runOnce 遍历两个 provider 各刷一轮(失败不中断;单号级失败已在 manager 内吞)。
func (a *autoRefresher) runOnce(nowMs int64) {
	_, _ = a.target.RefreshAllQuotas(account.ProviderCodex)
	_, _ = a.target.RefreshAllQuotas(account.ProviderAntigravity)
	a.mu.Lock()
	a.lastRunMs = nowMs
	a.mu.Unlock()
}

// start 启动后台循环:每分钟检查一次,到点就刷一轮。
func (a *autoRefresher) start(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				now := time.Now().UnixMilli()
				if a.dueAt(now) {
					a.runOnce(now)
				}
			}
		}
	}()
}

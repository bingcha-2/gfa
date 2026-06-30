// Package wakeup 周期性「唤醒」自有号(发起极小请求保活/防会话过期)。
// 调度判定/历史/配置是纯逻辑(可测);实际 ping 由外部注入(provider 特定,
// 需网关 + 真号,不在本包测试)。
package wakeup

import (
	"context"
	"sync"
	"time"

	"bcai-wails/internal/local/account"
)

const (
	defaultIntervalMin = 240 // 4h
	maxHistory         = 200
)

// RunEntry 一次对单个账号的唤醒结果。
// 续约保活语义:逐号刷 token(防过期)+ 轻探额度,记录 ok/err/新过期时间。
type RunEntry struct {
	AtMs      int64  `json:"atMs"`
	AccountID string `json:"accountId"`
	Email     string `json:"email"`
	Ok        bool   `json:"ok"`
	Err       string `json:"err,omitempty"`
	NewExpiry int64  `json:"newExpiry,omitempty"` // 续约后的 access_token 过期时刻(unix 秒,0=未变/未知)
}

type Config struct {
	Enabled         bool `json:"enabled"`
	IntervalMinutes int  `json:"intervalMinutes"`
}

// KeepAliveFunc 对某账号做一次续约保活(刷 token 防过期 + 轻探额度),
// 返回续约后的过期时刻(unix 秒,0=未变/未知)与错误(provider 特定,注入)。
type KeepAliveFunc func(ctx context.Context, a *account.Account) (newExpiry int64, err error)

// AccountsFunc 返回当前要保活的账号(池内自有号)。
type AccountsFunc func() []*account.Account

type Scheduler struct {
	mu         sync.Mutex
	cfg        Config
	lastRunMs  int64
	history    []RunEntry
	keepAlive  KeepAliveFunc
	accountsFn AccountsFunc
}

func New(keepAlive KeepAliveFunc, accountsFn AccountsFunc) *Scheduler {
	return &Scheduler{keepAlive: keepAlive, accountsFn: accountsFn, cfg: Config{IntervalMinutes: defaultIntervalMin}}
}

func (s *Scheduler) SetConfig(c Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.IntervalMinutes <= 0 {
		c.IntervalMinutes = defaultIntervalMin
	}
	s.cfg = c
}

func (s *Scheduler) GetConfig() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// DueAt 判定 now(unix ms)是否到了该跑一轮(启用 且 距上轮 ≥ 间隔)。
func (s *Scheduler) DueAt(nowMs int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.cfg.Enabled {
		return false
	}
	interval := s.cfg.IntervalMinutes
	if interval <= 0 {
		interval = defaultIntervalMin
	}
	return nowMs-s.lastRunMs >= int64(interval)*60_000
}

// RunOnce 立刻对所有目标账号唤醒一轮,记录历史,更新 lastRun。返回本轮结果。
func (s *Scheduler) RunOnce(ctx context.Context, nowMs int64) []RunEntry {
	var accts []*account.Account
	if s.accountsFn != nil {
		accts = s.accountsFn()
	}
	entries := make([]RunEntry, 0, len(accts))
	for _, a := range accts {
		var (
			newExpiry int64
			err       error
		)
		if s.keepAlive != nil {
			newExpiry, err = s.keepAlive(ctx, a)
		}
		e := RunEntry{AtMs: nowMs, AccountID: a.ID, Email: a.Email, Ok: err == nil, NewExpiry: newExpiry}
		if err != nil {
			e.Err = err.Error()
		}
		entries = append(entries, e)
	}
	s.mu.Lock()
	s.lastRunMs = nowMs
	s.history = append(s.history, entries...)
	if len(s.history) > maxHistory {
		s.history = s.history[len(s.history)-maxHistory:]
	}
	s.mu.Unlock()
	return entries
}

// Start 启动后台循环:每 checkEvery 检查一次,到点(DueAt)就跑一轮。
// 由调用方持有 ctx 控制停止。
func (s *Scheduler) Start(ctx context.Context, checkEvery time.Duration) {
	if checkEvery <= 0 {
		checkEvery = time.Minute
	}
	go func() {
		t := time.NewTicker(checkEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				now := time.Now().UnixMilli()
				if s.DueAt(now) {
					s.RunOnce(ctx, now)
				}
			}
		}
	}()
}

// History 返回最近的唤醒历史(新→旧)。
func (s *Scheduler) History() []RunEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]RunEntry, 0, len(s.history))
	for i := len(s.history) - 1; i >= 0; i-- {
		out = append(out, s.history[i])
	}
	return out
}

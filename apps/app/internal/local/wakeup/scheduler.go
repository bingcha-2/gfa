// Package wakeup 周期性「唤醒」自有号(发起极小请求保活/防会话过期)。
// 调度判定/历史/配置是纯逻辑(可测);实际 ping 由外部注入(provider 特定,
// 需网关 + 真号,不在本包测试)。
package wakeup

import (
	"context"
	"sync"

	"bcai-wails/internal/local/account"
)

const (
	defaultIntervalMin = 240 // 4h
	maxHistory         = 200
)

// RunEntry 一次对单个账号的唤醒结果。
type RunEntry struct {
	AtMs      int64  `json:"atMs"`
	AccountID string `json:"accountId"`
	Email     string `json:"email"`
	Ok        bool   `json:"ok"`
	Err       string `json:"err,omitempty"`
}

type Config struct {
	Enabled         bool `json:"enabled"`
	IntervalMinutes int  `json:"intervalMinutes"`
}

// PingFunc 对某账号做一次保活请求(provider 特定,注入)。
type PingFunc func(ctx context.Context, accountID string) error

// AccountsFunc 返回当前要保活的账号(通常是池内自有号)。
type AccountsFunc func() []*account.Account

type Scheduler struct {
	mu         sync.Mutex
	cfg        Config
	lastRunMs  int64
	history    []RunEntry
	pingFn     PingFunc
	accountsFn AccountsFunc
}

func New(pingFn PingFunc, accountsFn AccountsFunc) *Scheduler {
	return &Scheduler{pingFn: pingFn, accountsFn: accountsFn, cfg: Config{IntervalMinutes: defaultIntervalMin}}
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
		var err error
		if s.pingFn != nil {
			err = s.pingFn(ctx, a.ID)
		}
		e := RunEntry{AtMs: nowMs, AccountID: a.ID, Email: a.Email, Ok: err == nil}
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

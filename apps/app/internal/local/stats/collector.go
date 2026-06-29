// Package stats 收集本地网关的每请求用量(实现 CLIProxyAPI 的 usage.Plugin),
// 聚合成按账号/按模型/最近请求的快照,供「统计」tab 展示。
// 这是本地侧统计(网关数据),与远程主页统计物理分开。
package stats

import (
	"context"
	"sort"
	"sync"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

type ModelStat struct {
	Model       string `json:"model"`
	Requests    int    `json:"requests"`
	TotalTokens int64  `json:"totalTokens"`
}

type AccountStat struct {
	AuthID      string `json:"authId"`
	Email       string `json:"email"`
	Requests    int    `json:"requests"`
	TotalTokens int64  `json:"totalTokens"`
}

type RequestEntry struct {
	AtMs      int64  `json:"atMs"`
	AuthID    string `json:"authId"`
	Model     string `json:"model"`
	Failed    bool   `json:"failed"`
	LatencyMs int64  `json:"latencyMs"`
}

type Snapshot struct {
	TotalRequests     int           `json:"totalRequests"`
	TotalFailed       int           `json:"totalFailed"`
	TotalInputTokens  int64         `json:"totalInputTokens"`
	TotalOutputTokens int64         `json:"totalOutputTokens"`
	ByAccount         []AccountStat `json:"byAccount"`
	ByModel           []ModelStat   `json:"byModel"`
	Recent            []RequestEntry `json:"recent"`
}

const maxRecent = 100

type Collector struct {
	mu        sync.Mutex
	totalReq  int
	totalFail int
	totalIn   int64
	totalOut  int64
	byAccount map[string]*AccountStat
	byModel   map[string]*ModelStat
	recent    []RequestEntry
}

func NewCollector() *Collector {
	return &Collector{byAccount: map[string]*AccountStat{}, byModel: map[string]*ModelStat{}}
}

// HandleUsage 实现 usage.Plugin。
func (c *Collector) HandleUsage(ctx context.Context, r usage.Record) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.totalReq++
	if r.Failed {
		c.totalFail++
	}
	c.totalIn += r.Detail.InputTokens
	c.totalOut += r.Detail.OutputTokens

	tot := r.Detail.TotalTokens
	if tot == 0 {
		tot = r.Detail.InputTokens + r.Detail.OutputTokens
	}

	if r.AuthID != "" {
		a := c.byAccount[r.AuthID]
		if a == nil {
			a = &AccountStat{AuthID: r.AuthID}
			c.byAccount[r.AuthID] = a
		}
		a.Requests++
		a.TotalTokens += tot
	}
	if r.Model != "" {
		m := c.byModel[r.Model]
		if m == nil {
			m = &ModelStat{Model: r.Model}
			c.byModel[r.Model] = m
		}
		m.Requests++
		m.TotalTokens += tot
	}

	e := RequestEntry{AuthID: r.AuthID, Model: r.Model, Failed: r.Failed, LatencyMs: r.Latency.Milliseconds()}
	if !r.RequestedAt.IsZero() {
		e.AtMs = r.RequestedAt.UnixMilli()
	}
	c.recent = append(c.recent, e)
	if len(c.recent) > maxRecent {
		c.recent = c.recent[len(c.recent)-maxRecent:]
	}
}

// Snapshot 返回当前聚合(按请求数降序),最近请求为倒序(新→旧)。
func (c *Collector) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()

	s := Snapshot{
		TotalRequests:     c.totalReq,
		TotalFailed:       c.totalFail,
		TotalInputTokens:  c.totalIn,
		TotalOutputTokens: c.totalOut,
	}
	for _, a := range c.byAccount {
		cp := *a
		s.ByAccount = append(s.ByAccount, cp)
	}
	sort.Slice(s.ByAccount, func(i, j int) bool { return s.ByAccount[i].Requests > s.ByAccount[j].Requests })
	for _, m := range c.byModel {
		cp := *m
		s.ByModel = append(s.ByModel, cp)
	}
	sort.Slice(s.ByModel, func(i, j int) bool { return s.ByModel[i].Requests > s.ByModel[j].Requests })
	for i := len(c.recent) - 1; i >= 0; i-- {
		s.Recent = append(s.Recent, c.recent[i])
	}
	return s
}

// SetEmails 用 authID→email 映射补全账号统计的展示名(调用方持有账号 store)。
func (s *Snapshot) SetEmails(emails map[string]string) {
	for i := range s.ByAccount {
		if e, ok := emails[s.ByAccount[i].AuthID]; ok {
			s.ByAccount[i].Email = e
		}
	}
}

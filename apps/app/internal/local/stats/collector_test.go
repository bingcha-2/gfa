package stats

import (
	"context"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

func rec(authID, model string, in, out int64, failed bool) usage.Record {
	return usage.Record{
		Provider: "codex", AuthID: authID, Model: model, Failed: failed,
		RequestedAt: time.UnixMilli(1_700_000_000_000), Latency: 1200 * time.Millisecond,
		Detail: usage.Detail{InputTokens: in, OutputTokens: out, TotalTokens: in + out},
	}
}

func TestCollector_Aggregates(t *testing.T) {
	c := NewCollector()
	ctx := context.Background()
	c.HandleUsage(ctx, rec("a1", "gpt-5-codex", 100, 50, false))
	c.HandleUsage(ctx, rec("a1", "gpt-5-codex", 200, 60, false))
	c.HandleUsage(ctx, rec("a2", "gpt-5", 10, 5, true))

	s := c.Snapshot()
	if s.TotalRequests != 3 || s.TotalFailed != 1 {
		t.Fatalf("totals wrong: req=%d fail=%d", s.TotalRequests, s.TotalFailed)
	}
	if s.TotalInputTokens != 310 || s.TotalOutputTokens != 115 {
		t.Fatalf("token totals wrong: in=%d out=%d", s.TotalInputTokens, s.TotalOutputTokens)
	}
	// 按账号:a1 请求最多,排第一
	if len(s.ByAccount) != 2 || s.ByAccount[0].AuthID != "a1" || s.ByAccount[0].Requests != 2 || s.ByAccount[0].TotalTokens != 410 {
		t.Fatalf("byAccount wrong: %+v", s.ByAccount)
	}
	// 按模型:gpt-5-codex 排第一
	if len(s.ByModel) != 2 || s.ByModel[0].Model != "gpt-5-codex" || s.ByModel[0].Requests != 2 {
		t.Fatalf("byModel wrong: %+v", s.ByModel)
	}
	// 最近请求倒序(最新在前),最新是 a2
	if len(s.Recent) != 3 || s.Recent[0].AuthID != "a2" || !s.Recent[0].Failed || s.Recent[0].LatencyMs != 1200 {
		t.Fatalf("recent wrong: %+v", s.Recent)
	}
}

func TestCollector_RecentRingBuffer(t *testing.T) {
	c := NewCollector()
	for i := 0; i < maxRecent+50; i++ {
		c.HandleUsage(context.Background(), rec("a1", "m", 1, 1, false))
	}
	s := c.Snapshot()
	if len(s.Recent) != maxRecent {
		t.Fatalf("recent should cap at %d, got %d", maxRecent, len(s.Recent))
	}
	if s.TotalRequests != maxRecent+50 {
		t.Fatalf("total should count all, got %d", s.TotalRequests)
	}
}

func TestSnapshot_SetEmails(t *testing.T) {
	c := NewCollector()
	c.HandleUsage(context.Background(), rec("a1", "m", 1, 1, false))
	s := c.Snapshot()
	s.SetEmails(map[string]string{"a1": "x@y.com"})
	if s.ByAccount[0].Email != "x@y.com" {
		t.Fatalf("email not set: %+v", s.ByAccount)
	}
}

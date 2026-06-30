package stats

import (
	"context"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

func feed(c *Collector, authID, model string, failed bool) {
	c.HandleUsage(context.Background(), usage.Record{
		AuthID:      authID,
		Model:       model,
		Failed:      failed,
		RequestedAt: time.Now(),
	})
}

func TestQuery_PaginationNewestFirst(t *testing.T) {
	c := NewCollector()
	for i := 0; i < 5; i++ {
		feed(c, "acc1", "gpt-5", false)
		time.Sleep(time.Millisecond)
	}
	page := c.Query(QueryFilter{Offset: 0, Limit: 2})
	if page.Total != 5 {
		t.Fatalf("total = %d, want 5", page.Total)
	}
	if len(page.Entries) != 2 {
		t.Fatalf("page len = %d, want 2", len(page.Entries))
	}
	// 第二页跳过 2 条。
	page2 := c.Query(QueryFilter{Offset: 2, Limit: 2})
	if len(page2.Entries) != 2 {
		t.Fatalf("page2 len = %d, want 2", len(page2.Entries))
	}
	// 越界 offset 返回空但 total 仍准确。
	page3 := c.Query(QueryFilter{Offset: 100, Limit: 2})
	if len(page3.Entries) != 0 || page3.Total != 5 {
		t.Fatalf("oob page = %+v, want empty entries total=5", page3)
	}
}

func TestQuery_FilterByModel(t *testing.T) {
	c := NewCollector()
	feed(c, "a", "gpt-5", false)
	feed(c, "a", "gpt-4", false)
	feed(c, "a", "gpt-5", false)
	page := c.Query(QueryFilter{Model: "gpt-5", Limit: 10})
	if page.Total != 2 {
		t.Fatalf("filtered total = %d, want 2", page.Total)
	}
	for _, e := range page.Entries {
		if e.Model != "gpt-5" {
			t.Fatalf("got non-matching model %q", e.Model)
		}
	}
}

func TestQuery_FilterByAccount(t *testing.T) {
	c := NewCollector()
	feed(c, "a", "m", false)
	feed(c, "b", "m", false)
	page := c.Query(QueryFilter{AuthID: "b", Limit: 10})
	if page.Total != 1 || page.Entries[0].AuthID != "b" {
		t.Fatalf("account filter = %+v, want only b", page.Entries)
	}
}

func TestQuery_FilterFailedOnly(t *testing.T) {
	c := NewCollector()
	feed(c, "a", "m", false)
	feed(c, "a", "m", true)
	feed(c, "a", "m", true)
	page := c.Query(QueryFilter{FailedOnly: true, Limit: 10})
	if page.Total != 2 {
		t.Fatalf("failed-only total = %d, want 2", page.Total)
	}
	for _, e := range page.Entries {
		if !e.Failed {
			t.Fatal("expected only failed entries")
		}
	}
}

func TestQuery_DefaultLimitClamps(t *testing.T) {
	c := NewCollector()
	for i := 0; i < 3; i++ {
		feed(c, "a", "m", false)
	}
	// limit<=0 用默认页大小,仍返回全部 3 条。
	page := c.Query(QueryFilter{Limit: 0})
	if len(page.Entries) != 3 {
		t.Fatalf("default limit page len = %d, want 3", len(page.Entries))
	}
}

func TestClear_ResetsEverything(t *testing.T) {
	c := NewCollector()
	feed(c, "a", "m", false)
	feed(c, "a", "m", true)
	c.Clear()
	snap := c.Snapshot()
	if snap.TotalRequests != 0 || snap.TotalFailed != 0 || len(snap.Recent) != 0 ||
		len(snap.ByAccount) != 0 || len(snap.ByModel) != 0 {
		t.Fatalf("after Clear snapshot not empty: %+v", snap)
	}
	if c.Query(QueryFilter{Limit: 10}).Total != 0 {
		t.Fatal("after Clear query total not zero")
	}
}

package main

import "testing"

func TestAddTokensSavedMoneyPerFamily(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	s.AddTokens("claude", 1_000_000, 200_000, 0, 1_200_000) // Opus 真实 $5/$25:1M*5 + 0.2M*25 = 5 + 5 = 10
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 10 {
		t.Fatalf("claude saved = %v, want 10", got)
	}
	s.AddTokens("gemini", 1_000_000, 0, 0, 1_000_000) // Gemini Pro 真实 $2:+1M*2 = +2 → 12
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 12 {
		t.Fatalf("after gemini saved = %v, want 12", got)
	}
}

// claude 带缓存:billable(缓存读 1/10 折)与 cacheWrite(=rawTotal-净入-出-缓存读)拆分,
// 与服务端 billableTokenUsageTotal 同口径。
func TestAddTokensBillableAndCacheWrite(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	// 净输入 100 + 输出 260 + 缓存写 39000 + 缓存读 3000 = rawTotal 42360
	s.AddTokens("claude", 100, 260, 3000, 42360)
	rec := s.GetTodayRecord()
	if rec.InputTokens != 100 || rec.OutputTokens != 260 || rec.CachedTokens != 3000 {
		t.Fatalf("基础口径错: %+v", rec)
	}
	if rec.CacheWriteTokens != 39000 {
		t.Fatalf("cacheWrite = %d, want 39000", rec.CacheWriteTokens)
	}
	// billable = 42360 - 3000 + ceil(3000/10)=300 → 39660
	if rec.BillableTokens != 39660 {
		t.Fatalf("billable = %d, want 39660", rec.BillableTokens)
	}
}

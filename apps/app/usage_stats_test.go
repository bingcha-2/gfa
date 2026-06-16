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

func TestAddModelTokensRecordsModelBreakdown(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokens("claude", "claude-sonnet-4-20250514", 100, 260, 3000, 42360)

	rec := s.GetTodayRecord()
	row := rec.ByModel["claude-sonnet-4-20250514"]
	if row == nil {
		t.Fatalf("missing model breakdown: %+v", rec.ByModel)
	}
	if row.ModelKey != "claude-sonnet-4-20250514" || row.Family != "claude" || row.DisplayName != "Claude Sonnet" {
		t.Fatalf("model identity = %+v", row)
	}
	if row.Requests != 1 {
		t.Fatalf("requests = %d, want 1", row.Requests)
	}
	if row.InputTokens != 100 || row.OutputTokens != 260 || row.CachedTokens != 3000 || row.CacheWriteTokens != 39000 {
		t.Fatalf("token breakdown = %+v", row)
	}
	if row.TotalTokens != 42360 {
		t.Fatalf("total = %d, want 42360", row.TotalTokens)
	}
	wantCost := 0.25225
	if got := row.EstimatedCostUSD; got < wantCost-1e-9 || got > wantCost+1e-9 {
		t.Fatalf("estimated cost = %v, want %v", got, wantCost)
	}

	days := s.GetDailyRecords(1)
	if got := days[0].ByModel["claude-sonnet-4-20250514"]; got == nil || got.TotalTokens != 42360 {
		t.Fatalf("daily history did not include model breakdown: %+v", days[0].ByModel)
	}
	hour := s.HourlyRecords[hourKey()]
	if hour == nil {
		t.Fatalf("missing current hourly record")
	}
	hourlyRow := hour.ByModel["claude-sonnet-4-20250514"]
	if hourlyRow == nil || hourlyRow.TotalTokens != 42360 {
		t.Fatalf("hourly model breakdown = %+v", hour.ByModel)
	}
}

func TestAddModelTokensFallsBackToFamilyWhenModelKeyMissing(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokens("gpt", "", 1_000_000, 0, 0, 1_000_000)

	row := s.GetTodayRecord().ByModel["gpt"]
	if row == nil {
		t.Fatalf("missing fallback family row")
	}
	if row.ModelKey != "gpt" || row.DisplayName != "GPT" || row.Family != "gpt" {
		t.Fatalf("fallback identity = %+v", row)
	}
	if row.TotalTokens != 1_000_000 || row.EstimatedCostUSD != 1.25 {
		t.Fatalf("fallback usage = %+v", row)
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
	// 真实节省(全口径,含缓存):net入100*5 + 出260*25 + 缓存读3000*0.5 + 缓存写39000*6.25
	// = (500 + 6500 + 1500 + 243750)/1e6 = 0.25225 USD。缓存写 0.24375 是大头。
	want := 0.25225
	if got := rec.SavedMoneyUSD; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("saved(含缓存) = %v, want %v", got, want)
	}
}

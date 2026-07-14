package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteFileReplacesWholeFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage_stats.json")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(path, []byte(`{"records":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"records":{}}` {
		t.Fatalf("content = %q", got)
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".usage_stats.json.tmp-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files left behind: %v, err=%v", matches, err)
	}
}

func TestUsageStatsNamespacesAreIsolatedByServerUserID(t *testing.T) {
	origConfigDir = t.TempDir()
	defer func() { origConfigDir = "" }()
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	s.SwitchNamespace("customer-a")
	s.AddTokens("gpt", 123, 0, 0, 123)
	s.Save()
	s.SwitchNamespace("customer-b")
	if got := s.GetTodayRecord().InputTokens; got != 0 {
		t.Fatalf("customer-b inherited customer-a local usage: %d", got)
	}
	s.AddTokens("gpt", 456, 0, 0, 456)
	s.Save()
	s.SwitchNamespace("customer-a")
	if got := s.GetTodayRecord().InputTokens; got != 123 {
		t.Fatalf("customer-a usage = %d, want 123", got)
	}
	if _, err := os.Stat(filepath.Join(origConfigDir, "usage_stats.customer-a.json")); err != nil {
		t.Fatalf("missing customer-a file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(origConfigDir, "usage_stats.customer-b.json")); err != nil {
		t.Fatalf("missing customer-b file: %v", err)
	}
}

func TestUsageStatsLegacyFileMigratesOnlyOnce(t *testing.T) {
	origConfigDir = t.TempDir()
	defer func() { origConfigDir = "" }()
	legacy := `{"records":{"2026-07-14":{"date":"2026-07-14","inputTokens":77}},"hourlyRecords":{}}`
	if err := os.WriteFile(filepath.Join(origConfigDir, "usage_stats.json"), []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	s.SwitchNamespace("customer-first")
	if s.Records["2026-07-14"].InputTokens != 77 {
		t.Fatal("first user did not receive legacy history")
	}
	s.SwitchNamespace("customer-second")
	if len(s.Records) != 0 {
		t.Fatal("legacy history was copied into a second user")
	}
}

func TestSyncParentDirectorySkipsUnsupportedWindowsDirectoryFsync(t *testing.T) {
	// The path deliberately does not exist. Windows must not try to open/sync it:
	// os.File.Sync on a directory returns ERROR_ACCESS_DENIED there even after the
	// file itself was synced and atomically renamed successfully.
	missingDir := filepath.Join(t.TempDir(), "missing")
	if err := syncParentDirectory(missingDir, "windows"); err != nil {
		t.Fatalf("Windows directory sync must be skipped, got %v", err)
	}
}

func TestRepriceModelUsageMarksHistoricalAggregateQuality(t *testing.T) {
	row := &ModelUsageRecord{
		ModelKey: "gpt-5.6-sol", Family: "gpt",
		InputTokens: 593_410, OutputTokens: 102_560, CachedTokens: 24_470_000,
		TotalTokens: 25_165_970,
	}
	if !repriceModelUsage(row, mustUsageDate("2026-07-11")) {
		t.Fatal("expected legacy row to migrate")
	}
	if row.EstimatedCostUSD < 18.27885-1e-9 || row.EstimatedCostUSD > 18.27885+1e-9 {
		t.Fatalf("recalculated cost = %v", row.EstimatedCostUSD)
	}
	if row.PricingVersion != "api-pricing-2026-07-14" || row.PricingQuality != "recalculated-aggregate" {
		t.Fatalf("migration metadata = %+v", row)
	}
	if repriceModelUsage(row, mustUsageDate("2026-07-11")) {
		t.Fatal("migration must be idempotent")
	}
}

func TestAddTokensSavedMoneyPerFamily(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	// 没有 model id 时也只查 api-pricing.json，并使用该 provider 的保守最高价。
	s.AddTokens("claude", 1_000_000, 200_000, 0, 1_200_000) // 当前仍可用 Opus 4.1:1M*15 + 0.2M*75 = 30
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 30 {
		t.Fatalf("claude saved = %v, want 30", got)
	}
	s.AddTokens("gemini", 1_000_000, 0, 0, 1_000_000) // 非 Codex/Claude 仍走原 family 表：+2 → 32
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 32 {
		t.Fatalf("after gemini saved = %v, want 32", got)
	}
}

func TestAddModelTokensRecordsModelBreakdown(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokens("claude", "claude-sonnet-4-6", 100, 260, 3000, 42360, false)

	rec := s.GetTodayRecord()
	row := rec.ByModel["claude-sonnet-4-6"]
	if row == nil {
		t.Fatalf("missing model breakdown: %+v", rec.ByModel)
	}
	if row.ModelKey != "claude-sonnet-4-6" || row.Family != "claude" || row.DisplayName != "Claude Sonnet" {
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
	wantCost := 0.15135
	if got := row.EstimatedCostUSD; got < wantCost-1e-9 || got > wantCost+1e-9 {
		t.Fatalf("estimated cost = %v, want %v", got, wantCost)
	}

	days := s.GetDailyRecords(1)
	if got := days[0].ByModel["claude-sonnet-4-6"]; got == nil || got.TotalTokens != 42360 {
		t.Fatalf("daily history did not include model breakdown: %+v", days[0].ByModel)
	}
	hour := s.HourlyRecords[hourKey()]
	if hour == nil {
		t.Fatalf("missing current hourly record")
	}
	hourlyRow := hour.ByModel["claude-sonnet-4-6"]
	if hourlyRow == nil || hourlyRow.TotalTokens != 42360 {
		t.Fatalf("hourly model breakdown = %+v", hour.ByModel)
	}
}

// Anthropic charges 1h cache creation at a different rate from 5m cache
// creation. The local dashboard must retain that split instead of deriving one
// undifferentiated cache-write bucket from rawTotal.
func TestAddModelTokensWithCacheWritesPricesClaudeTTLBreakdown(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokensWithCacheWrites("claude", "claude-opus-4-8",
		0, 0, 0, 100_000, 100_000, 200_000, false)

	row := s.GetTodayRecord().ByModel["claude-opus-4-8"]
	if row == nil {
		t.Fatal("missing Claude model row")
	}
	// Opus 4.8: 100K 5m * $6.25/M + 100K 1h * $10/M = $1.625.
	if want := 1.625; row.EstimatedCostUSD < want-1e-9 || row.EstimatedCostUSD > want+1e-9 {
		t.Fatalf("cost = %v, want %v (5m/1h cache writes must use distinct prices)", row.EstimatedCostUSD, want)
	}
	if row.CacheWriteTokens != 200_000 || row.TotalTokens != 200_000 {
		t.Fatalf("cache write aggregate = %+v", row)
	}
}

func TestRecordClaudeUsageStatsForwardsCacheWriteTTLBreakdown(t *testing.T) {
	prev := globalUsageStats
	globalUsageStats = &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	defer func() { globalUsageStats = prev }()

	recordClaudeUsageStats("claude-opus-4-8", ReportDetails{
		CacheWrite5mTokens: 100_000,
		CacheWrite1hTokens: 100_000,
		RawTotalTokens:     200_000,
	})

	row := globalUsageStats.GetTodayRecord().ByModel["claude-opus-4-8"]
	if row == nil || row.EstimatedCostUSD < 1.625-1e-9 || row.EstimatedCostUSD > 1.625+1e-9 {
		t.Fatalf("Claude proxy dashboard row = %+v, want split cache-write cost 1.625", row)
	}
}

func TestAddModelTokensUsesAPIRegistryConservativeFallbackWhenCodexModelKeyMissing(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokens("gpt", "", 1_000_000, 0, 0, 1_000_000, false)

	row := s.GetTodayRecord().ByModel["gpt"]
	if row == nil {
		t.Fatalf("missing fallback family row")
	}
	if row.ModelKey != "gpt" || row.DisplayName != "GPT" || row.Family != "gpt" {
		t.Fatalf("fallback identity = %+v", row)
	}
	if row.TotalTokens != 1_000_000 || row.EstimatedCostUSD != 10 || row.PricingQuality != "conservative-fallback" {
		t.Fatalf("fallback usage = %+v", row)
	}
	if row.PricingVersion != exactAPIPrices.Version {
		t.Fatalf("fallback pricing provenance = %+v", row)
	}
}

func TestAddModelTokensUsesAPIRegistryConservativeFallbackWhenClaudeModelKeyMissing(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	s.AddModelTokens("claude", "", 1_000_000, 0, 0, 1_000_000, false)

	row := s.GetTodayRecord().ByModel["claude"]
	if row == nil || row.PricingQuality != "conservative-fallback" {
		t.Fatalf("Claude fallback usage = %+v", row)
	}
	if row.PricingVersion != exactAPIPrices.Version {
		t.Fatalf("Claude fallback pricing provenance = %+v", row)
	}
}

// 快速档使用官方 Priority 模型价,不再拿 Standard 粗暴乘 1.5。
func TestAddModelTokensFastUsesOfficialPriorityAndTracksFastTokens(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}

	// 标准档基线:gpt-5.5 1M input → $5。
	s.AddModelTokens("gpt", "gpt-5.5", 1_000_000, 0, 0, 1_000_000, false)
	std := s.GetTodayRecord().ByModel["gpt-5.5"]
	if std.EstimatedCostUSD != 10 || std.FastTokens != 0 {
		t.Fatalf("标准档 row = %+v, want long-context cost=10 fastTokens=0", std)
	}

	// Priority 暂未发布 long 档,明确回退其 short 官方价 $12.5/M,累计 $22.5。
	s.AddModelTokens("gpt", "gpt-5.5", 1_000_000, 0, 0, 1_000_000, true)
	row := s.GetTodayRecord().ByModel["gpt-5.5"]
	if got := row.EstimatedCostUSD; got < 22.5-1e-9 || got > 22.5+1e-9 {
		t.Fatalf("fast 后成本 = %v, want 22.5", got)
	}
	if row.FastTokens != 1_000_000 {
		t.Fatalf("FastTokens = %d, want 1000000", row.FastTokens)
	}
	if row.Requests != 2 {
		t.Fatalf("requests = %d, want 2", row.Requests)
	}
}

// codex/gpt 带缓存:Responses API 的 input_tokens 是 gross(含 cached)。reportUsageSafe
// 必须先还原净输入再入账,否则缓存命中被按整价 input + 缓存价计两遍(约 11x 虚高,整体金额翻倍)。
func TestReportUsageSafeCodexNetsOutCachedInput(t *testing.T) {
	prev := globalUsageStats
	globalUsageStats = &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	defer func() { globalUsageStats = prev }()

	p := &CodexProxy{reportResult: func(string, string, ReportDetails, string, *CodexTokenLease) {}}
	// gross 输入 1000(其中缓存 900)+ 输出 200,total = 1200。BillableTotalTokens=0 跳过本地额度入账。
	p.reportUsageSafe("card", "dev", ReportDetails{
		ModelKey:          "gpt-5.6-luna",
		InputTokens:       1000,
		OutputTokens:      200,
		CachedInputTokens: 900,
		RawTotalTokens:    1200,
	}, "", nil)

	row := globalUsageStats.GetTodayRecord().ByModel["gpt-5.6-luna"]
	if row == nil {
		t.Fatalf("missing codex model row")
	}
	// 正确口径:净输入 100*1.25 + 输出 200*10 + 缓存读 900*0.125,/1e6 = 0.0022375 USD。
	// bug 口径(gross 当净输入):1000*1.25 + 200*10 + 900*0.125 = 0.0033625,约多算 50%+。
	want := 0.00139
	if got := row.EstimatedCostUSD; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("codex cost = %v, want %v(缓存命中不得按整价重复计)", got, want)
	}
	if row.InputTokens != 100 || row.CachedTokens != 900 || row.CacheWriteTokens != 0 {
		t.Fatalf("codex token breakdown = %+v", row)
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
	// 缺模型 id 时按 api-pricing.json 中 Anthropic 的保守最高价：
	// 当前保守最高价是仍可用的 Opus 4.1：
	// net入100*15 + 出260*75 + 缓存读3000*1.5 + 缓存写39000*18.75 = 0.75675 USD。
	want := 0.75675
	if got := rec.SavedMoneyUSD; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("saved(含缓存) = %v, want %v", got, want)
	}
}

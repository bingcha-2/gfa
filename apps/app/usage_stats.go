package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ModelUsageRecord records token usage and official API value by model.
type ModelUsageRecord struct {
	ModelKey         string  `json:"modelKey"`
	DisplayName      string  `json:"displayName"`
	Family           string  `json:"family"`
	Requests         int64   `json:"requests"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CachedTokens     int64   `json:"cachedTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	TotalTokens      int64   `json:"totalTokens"`
	EstimatedCostUSD float64 `json:"estimatedCostUSD"`
	PricingVersion   string  `json:"pricingVersion,omitempty"`
	PricingMode      string  `json:"pricingMode,omitempty"`
	PricingQuality   string  `json:"pricingQuality,omitempty"`
	// FastTokens:走「快速档」(codex service_tier=priority)请求的**原始** token(与 TotalTokens
	// 同口径,含缓存),供看板「其中 fast」列直接对比占比。成本溢价 1.5x 在 EstimatedCostUSD 里。
	FastTokens int64 `json:"fastTokens"`
}

// DailyRecord 单日用量记录
type DailyRecord struct {
	Date             string                       `json:"date"` // "2026-05-22"
	InputTokens      int64                        `json:"inputTokens"`
	OutputTokens     int64                        `json:"outputTokens"`
	CachedTokens     int64                        `json:"cachedTokens"`     // 缓存读 cache_read
	CacheWriteTokens int64                        `json:"cacheWriteTokens"` // 缓存写 cache_creation(全价计费)
	BillableTokens   int64                        `json:"billableTokens"`   // 计费口径,与服务端 billableTokenUsageTotal 同(缓存读 1/10 折)
	Requests         int64                        `json:"requests"`
	Errors           int64                        `json:"errors"`
	Retries          int64                        `json:"retries"`
	Generations      int64                        `json:"generations"`
	SavedMoneyUSD    float64                      `json:"savedMoneyUSD"`
	ByModel          map[string]*ModelUsageRecord `json:"byModel,omitempty"`
}

// HourlyRecord 每小时用量记录
type HourlyRecord struct {
	ByModel          map[string]*ModelUsageRecord `json:"byModel,omitempty"`
	Hour             string                       `json:"hour"` // "15" (0-23)
	InputTokens      int64                        `json:"inputTokens"`
	OutputTokens     int64                        `json:"outputTokens"`
	CachedTokens     int64                        `json:"cachedTokens"`     // 缓存读 cache_read
	CacheWriteTokens int64                        `json:"cacheWriteTokens"` // 缓存写 cache_creation
}

// UsageStatsStore 用量统计持久化
type UsageStatsStore struct {
	mu            sync.Mutex
	Records       map[string]*DailyRecord  `json:"records"`       // key = "2026-05-22"
	HourlyRecords map[string]*HourlyRecord `json:"hourlyRecords"` // key = "2026-05-22T15"
	dirty         bool
}

var globalUsageStats = &UsageStatsStore{
	Records:       make(map[string]*DailyRecord),
	HourlyRecords: make(map[string]*HourlyRecord),
}

func GetUsageStats() *UsageStatsStore {
	return globalUsageStats
}

func todayKey() string {
	return time.Now().Format("2006-01-02")
}

func hourKey() string {
	return time.Now().Format("2006-01-02T15")
}

func normalizeUsageFamily(family, modelKey string) string {
	family = strings.ToLower(strings.TrimSpace(family))
	if family == "" || family == "other" {
		if inferred := modelFamily(strings.TrimSpace(modelKey)); inferred != "" && inferred != "other" {
			family = inferred
		}
	}
	if family == "" {
		return "other"
	}
	return family
}

func modelUsageKey(family, modelKey string) string {
	key := strings.TrimSpace(modelKey)
	if key != "" {
		return key
	}
	if family != "" {
		return family
	}
	return "other"
}

func modelUsageDisplayName(family, modelKey string) string {
	lower := strings.ToLower(strings.TrimSpace(modelKey))
	switch {
	case lower == "":
		return familyDisplayName(family)
	case strings.Contains(lower, "sonnet"):
		return "Claude Sonnet"
	case strings.Contains(lower, "opus"):
		return "Claude Opus"
	case strings.Contains(lower, "haiku"):
		return "Claude Haiku"
	case strings.Contains(lower, "gemini") && strings.Contains(lower, "flash"):
		return "Gemini Flash"
	case strings.Contains(lower, "gemini") && strings.Contains(lower, "pro"):
		return "Gemini Pro"
	case strings.Contains(lower, "gemini"):
		return "Gemini"
	case strings.Contains(lower, "codex"):
		return "GPT Codex"
	case strings.Contains(lower, "gpt"):
		return "GPT"
	default:
		return strings.TrimSpace(modelKey)
	}
}

func familyDisplayName(family string) string {
	switch family {
	case "claude":
		return "Claude"
	case "gemini":
		return "Gemini"
	case "gpt":
		return "GPT"
	default:
		if family == "" {
			return "Other"
		}
		return family
	}
}

func estimateOfficialCostUSD(family string, input, output, cacheRead, cacheWrite int64) float64 {
	inP, outP := priceFor(family)
	cacheReadP, cacheWriteP := cachePriceFor(family)
	return float64(input)/1_000_000.0*inP +
		float64(output)/1_000_000.0*outP +
		float64(cacheRead)/1_000_000.0*cacheReadP +
		float64(cacheWrite)/1_000_000.0*cacheWriteP
}

func addModelUsage(byModel map[string]*ModelUsageRecord, family, modelKey string, input, output, cacheRead, cacheWrite int64, value apiValue, fastTokens int64) {
	key := modelUsageKey(family, modelKey)
	row, ok := byModel[key]
	if !ok {
		row = &ModelUsageRecord{
			ModelKey:    key,
			DisplayName: modelUsageDisplayName(family, modelKey),
			Family:      family,
		}
		byModel[key] = row
	}
	row.Requests++
	row.InputTokens += input
	row.OutputTokens += output
	row.CachedTokens += cacheRead
	row.CacheWriteTokens += cacheWrite
	row.TotalTokens += input + output + cacheRead + cacheWrite
	row.EstimatedCostUSD += value.USD
	if row.PricingVersion == "" {
		row.PricingVersion = value.PricingVersion
	}
	if row.PricingMode == "" {
		row.PricingMode = value.PricingMode
	} else if row.PricingMode != value.PricingMode {
		row.PricingMode = "mixed"
	}
	if row.PricingQuality == "" {
		row.PricingQuality = value.Quality
	} else if row.PricingQuality != value.Quality {
		row.PricingQuality = "mixed"
	}
	row.FastTokens += fastTokens
}

func cloneModelUsageMap(in map[string]*ModelUsageRecord) map[string]*ModelUsageRecord {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]*ModelUsageRecord, len(in))
	for k, v := range in {
		if v == nil {
			continue
		}
		cp := *v
		out[k] = &cp
	}
	return out
}

func cloneDailyRecord(rec *DailyRecord) DailyRecord {
	cp := *rec
	cp.ByModel = cloneModelUsageMap(rec.ByModel)
	return cp
}

func cloneHourlyRecord(rec *HourlyRecord) HourlyRecord {
	cp := *rec
	cp.ByModel = cloneModelUsageMap(rec.ByModel)
	return cp
}

func mustUsageDate(value string) time.Time {
	at, err := time.ParseInLocation("2006-01-02", value, time.Local)
	if err != nil {
		return time.Now()
	}
	return at.Add(12 * time.Hour)
}

func repriceModelUsage(row *ModelUsageRecord, at time.Time) bool {
	if row == nil || row.PricingVersion == exactAPIPrices.Version {
		return false
	}
	provider := ""
	if row.Family == "gpt" {
		provider = "codex"
	}
	if row.Family == "claude" {
		provider = "anthropic"
	}
	if provider == "" || strings.TrimSpace(row.ModelKey) == "" {
		return false
	}
	ratio := 0.0
	if row.TotalTokens > 0 {
		ratio = math.Min(1, math.Max(0, float64(row.FastTokens)/float64(row.TotalTokens)))
	}
	fastPart := func(value int64) int64 { return int64(math.Round(float64(value) * ratio)) }
	fi, fo, fr, fw := fastPart(row.InputTokens), fastPart(row.OutputTokens), fastPart(row.CachedTokens), fastPart(row.CacheWriteTokens)
	// Historical aggregates do not preserve per-request context length. Reprice
	// them with the published short tier and label the result as aggregate.
	const context int64 = 0
	standard := calculateAPIValue(provider, row.ModelKey, "standard", context,
		row.InputTokens-fi, row.OutputTokens-fo, row.CachedTokens-fr, row.CacheWriteTokens-fw, 0, at)
	priority := apiValue{}
	if ratio > 0 {
		priority = calculateAPIValue(provider, row.ModelKey, "priority", context, fi, fo, fr, fw, 0, at)
	}
	row.EstimatedCostUSD = standard.USD + priority.USD
	row.PricingVersion = exactAPIPrices.Version
	row.PricingMode = "standard"
	if ratio > 0 {
		row.PricingMode = "mixed"
	}
	row.PricingQuality = "recalculated-aggregate"
	return true
}

func migrateUsagePricing(records map[string]*DailyRecord, hourly map[string]*HourlyRecord) bool {
	migrated := false
	for date, record := range records {
		if record == nil {
			continue
		}
		value := 0.0
		for _, row := range record.ByModel {
			if repriceModelUsage(row, mustUsageDate(date)) {
				migrated = true
			}
			if row != nil {
				value += row.EstimatedCostUSD
			}
		}
		if len(record.ByModel) > 0 {
			record.SavedMoneyUSD = value
		}
	}
	for key, record := range hourly {
		if record == nil {
			continue
		}
		date := strings.SplitN(key, "T", 2)[0]
		for _, row := range record.ByModel {
			if repriceModelUsage(row, mustUsageDate(date)) {
				migrated = true
			}
		}
	}
	return migrated
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) (err error) {
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmpPath, path); err != nil {
		return err
	}
	if dirHandle, openErr := os.Open(dir); openErr == nil {
		err = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return err
}

func createBackupIfAbsent(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

// Load 从磁盘加载
func (s *UsageStatsStore) Load() {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(getAppDataDir(), "usage_stats.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var loaded struct {
		Records       map[string]*DailyRecord  `json:"records"`
		HourlyRecords map[string]*HourlyRecord `json:"hourlyRecords"`
	}
	if json.Unmarshal(data, &loaded) == nil {
		records := loaded.Records
		hourly := loaded.HourlyRecords
		if records == nil {
			records = map[string]*DailyRecord{}
		}
		if hourly == nil {
			hourly = map[string]*HourlyRecord{}
		}
		if migrateUsagePricing(records, hourly) {
			backup := filepath.Join(getAppDataDir(), "usage_stats.pre-model-pricing.json")
			if backupErr := createBackupIfAbsent(backup, data); backupErr != nil {
				Log("[stats] pricing migration backup failed: %v", backupErr)
				// Never publish migrated values without a recoverable original.
				_ = json.Unmarshal(data, &loaded)
				records, hourly = loaded.Records, loaded.HourlyRecords
				if records == nil {
					records = map[string]*DailyRecord{}
				}
				if hourly == nil {
					hourly = map[string]*HourlyRecord{}
				}
			} else {
				s.dirty = true
			}
		}
		s.Records, s.HourlyRecords = records, hourly
	}
	// 清理超过 7 天的小时记录
	cutoff := time.Now().AddDate(0, 0, -7).Format("2006-01-02T15")
	for k := range s.HourlyRecords {
		if k < cutoff {
			delete(s.HourlyRecords, k)
		}
	}
	Log("[stats] Loaded usage stats: %d days, %d hourly records", len(s.Records), len(s.HourlyRecords))
}

// Save 写入磁盘
func (s *UsageStatsStore) Save() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.dirty {
		return
	}

	dir := getAppDataDir()
	path := filepath.Join(dir, "usage_stats.json")

	payload := struct {
		Records       map[string]*DailyRecord  `json:"records"`
		HourlyRecords map[string]*HourlyRecord `json:"hourlyRecords"`
	}{Records: s.Records, HourlyRecords: s.HourlyRecords}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	if err := atomicWriteFile(path, data, 0644); err != nil {
		Log("[stats] save failed: %v", err)
		return
	}
	s.dirty = false
}

// getToday 获取或创建当天记录
func (s *UsageStatsStore) getToday() *DailyRecord {
	key := todayKey()
	rec, ok := s.Records[key]
	if !ok {
		rec = &DailyRecord{Date: key}
		s.Records[key] = rec
	}
	return rec
}

// getHour 获取或创建当前小时记录
func (s *UsageStatsStore) getHour() *HourlyRecord {
	key := hourKey()
	rec, ok := s.HourlyRecords[key]
	if !ok {
		rec = &HourlyRecord{Hour: time.Now().Format("15")}
		s.HourlyRecords[key] = rec
	}
	return rec
}

// AddTokens preserves the legacy aggregate-only call path.
func (s *UsageStatsStore) AddTokens(family string, input, output, cacheRead, rawTotal int64) {
	s.AddModelTokens(family, "", input, output, cacheRead, rawTotal, false)
}

// AddModelTokens adds token usage and records the model-level API value estimate.
// fast=true(codex 快速档 service_tier=priority)时,成本按 codexFastCostMultiplier(1.5x)计,
// 并把本次计费 token 记入「其中 fast」。
func (s *UsageStatsStore) AddModelTokens(family, modelKey string, input, output, cacheRead, rawTotal int64, fast bool) {
	cacheWrite := rawTotal - input - output - cacheRead
	if cacheWrite < 0 {
		cacheWrite = 0
	}
	// Legacy callers do not carry Anthropic's TTL split. Preserve their prior
	// conservative behaviour by treating the aggregate as 5m cache creation.
	s.AddModelTokensWithCacheWrites(family, modelKey, input, output, cacheRead, cacheWrite, 0, rawTotal, fast)
}

// AddModelTokensWithCacheWrites records model usage while retaining Anthropic's
// distinct 5m/1h cache-creation prices. rawTotal remains the compatibility
// aggregate; if an older upstream omits part of the split, the residual is
// conservatively assigned to the 5m bucket.
func (s *UsageStatsStore) AddModelTokensWithCacheWrites(family, modelKey string, input, output, cacheRead, cacheWrite5m, cacheWrite1h, rawTotal int64, fast bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	family = normalizeUsageFamily(family, modelKey)
	if cacheWrite5m < 0 {
		cacheWrite5m = 0
	}
	if cacheWrite1h < 0 {
		cacheWrite1h = 0
	}
	derivedCacheWrite := rawTotal - input - output - cacheRead
	if derivedCacheWrite < 0 {
		derivedCacheWrite = 0
	}
	if missing := derivedCacheWrite - cacheWrite5m - cacheWrite1h; missing > 0 {
		cacheWrite5m += missing
	}
	cacheWrite := cacheWrite5m + cacheWrite1h
	componentTotal := input + output + cacheRead + cacheWrite
	if rawTotal < componentTotal {
		rawTotal = componentTotal
	}
	billable := rawTotal
	if cacheRead > 0 {
		billable = rawTotal - cacheRead + discountedCachedTokens(cacheRead)
		if billable < 0 {
			billable = 0
		}
	}
	provider := ""
	if family == "gpt" {
		provider = "codex"
	}
	if family == "claude" {
		provider = "anthropic"
	}
	mode := "standard"
	if fast {
		mode = "priority"
	}
	value := apiValue{USD: estimateOfficialCostUSD(family, input, output, cacheRead, cacheWrite), Quality: "legacy-family", PricingMode: mode}
	if provider != "" && strings.TrimSpace(modelKey) != "" {
		value = calculateAPIValue(provider, modelKey, mode, input+cacheRead+cacheWrite,
			input, output, cacheRead, cacheWrite5m, cacheWrite1h, time.Now())
	}
	var fastTokens int64
	if fast {
		fastTokens = input + output + cacheRead + cacheWrite // 原始量,与 TotalTokens 同口径
	}

	rec := s.getToday()
	rec.InputTokens += input
	rec.OutputTokens += output
	rec.CachedTokens += cacheRead
	rec.CacheWriteTokens += cacheWrite
	rec.BillableTokens += billable
	rec.SavedMoneyUSD += value.USD
	if rec.ByModel == nil {
		rec.ByModel = make(map[string]*ModelUsageRecord)
	}
	addModelUsage(rec.ByModel, family, modelKey, input, output, cacheRead, cacheWrite, value, fastTokens)

	hr := s.getHour()
	hr.InputTokens += input
	hr.OutputTokens += output
	hr.CachedTokens += cacheRead
	hr.CacheWriteTokens += cacheWrite
	if hr.ByModel == nil {
		hr.ByModel = make(map[string]*ModelUsageRecord)
	}
	addModelUsage(hr.ByModel, family, modelKey, input, output, cacheRead, cacheWrite, value, fastTokens)
	s.dirty = true
}

func (s *UsageStatsStore) AddRequest() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getToday().Requests++
	s.dirty = true
}

// AddError 添加错误计数
func (s *UsageStatsStore) AddError() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getToday().Errors++
	s.dirty = true
}

// AddRetry 添加重试计数
func (s *UsageStatsStore) AddRetry() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getToday().Retries++
	s.dirty = true
}

// AddGeneration 添加成功生成计数
func (s *UsageStatsStore) AddGeneration() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getToday().Generations++
	s.dirty = true
}

// GetTodayRecord 获取当天记录（拷贝）
func (s *UsageStatsStore) GetTodayRecord() DailyRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneDailyRecord(s.getToday())
}

// GetDailyRecords 获取最近 N 天的记录（按日期倒序）
func (s *UsageStatsStore) GetDailyRecords(days int) []DailyRecord {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([]DailyRecord, 0, days)
	now := time.Now()
	for i := 0; i < days; i++ {
		key := now.AddDate(0, 0, -i).Format("2006-01-02")
		if rec, ok := s.Records[key]; ok {
			result = append(result, cloneDailyRecord(rec))
		} else {
			result = append(result, DailyRecord{Date: key})
		}
	}
	return result
}

// GetTodayHourlyRecords 获取今天24小时的记录
func (s *UsageStatsStore) GetTodayHourlyRecords() []HourlyRecord {
	s.mu.Lock()
	defer s.mu.Unlock()

	today := todayKey()
	result := make([]HourlyRecord, 24)
	for h := 0; h < 24; h++ {
		key := fmt.Sprintf("%sT%02d", today, h)
		if rec, ok := s.HourlyRecords[key]; ok {
			result[h] = cloneHourlyRecord(rec)
		}
		result[h].Hour = fmt.Sprintf("%02d:00", h)
	}
	return result
}

// HasMultipleDays 是否有超过一天的数据
func (s *UsageStatsStore) HasMultipleDays() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, rec := range s.Records {
		if rec.InputTokens > 0 || rec.OutputTokens > 0 || rec.Requests > 0 {
			count++
			if count > 1 {
				return true
			}
		}
	}
	return false
}

// GetCumulativeSavings 获取累计节省金额
func (s *UsageStatsStore) GetCumulativeSavings() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var total float64
	for _, rec := range s.Records {
		total += rec.SavedMoneyUSD
	}
	return total
}

// GetCumulativeTokens 获取累计 token
func (s *UsageStatsStore) GetCumulativeTokens() (input, output, cached int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range s.Records {
		input += rec.InputTokens
		output += rec.OutputTokens
		cached += rec.CachedTokens
	}
	return
}

// Reset 清空所有用量统计（换卡时调用）
func (s *UsageStatsStore) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Records = make(map[string]*DailyRecord)
	s.HourlyRecords = make(map[string]*HourlyRecord)
	s.dirty = false
	// 删除磁盘文件
	path := filepath.Join(getAppDataDir(), "usage_stats.json")
	_ = os.Remove(path)
	Log("[stats] Usage stats reset (card changed)")
}

// StartAutoSave 定期保存
func (s *UsageStatsStore) StartAutoSave() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			s.Save()
		}
	}()
}

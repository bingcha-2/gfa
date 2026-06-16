package main

import (
	"encoding/json"
	"fmt"
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

func addModelUsage(byModel map[string]*ModelUsageRecord, family, modelKey string, input, output, cacheRead, cacheWrite int64, cost float64) {
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
	row.EstimatedCostUSD += cost
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
		if loaded.Records != nil {
			s.Records = loaded.Records
		}
		if loaded.HourlyRecords != nil {
			s.HourlyRecords = loaded.HourlyRecords
		}
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
	_ = os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, "usage_stats.json")

	payload := struct {
		Records       map[string]*DailyRecord  `json:"records"`
		HourlyRecords map[string]*HourlyRecord `json:"hourlyRecords"`
	}{Records: s.Records, HourlyRecords: s.HourlyRecords}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0644)
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
	s.AddModelTokens(family, "", input, output, cacheRead, rawTotal)
}

// AddModelTokens adds token usage and records the model-level API value estimate.
func (s *UsageStatsStore) AddModelTokens(family, modelKey string, input, output, cacheRead, rawTotal int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	family = normalizeUsageFamily(family, modelKey)
	billable := rawTotal
	if cacheRead > 0 {
		billable = rawTotal - cacheRead + discountedCachedTokens(cacheRead)
		if billable < 0 {
			billable = 0
		}
	}
	cacheWrite := rawTotal - input - output - cacheRead
	if cacheWrite < 0 {
		cacheWrite = 0
	}
	cost := estimateOfficialCostUSD(family, input, output, cacheRead, cacheWrite)

	rec := s.getToday()
	rec.InputTokens += input
	rec.OutputTokens += output
	rec.CachedTokens += cacheRead
	rec.CacheWriteTokens += cacheWrite
	rec.BillableTokens += billable
	rec.SavedMoneyUSD += cost
	if rec.ByModel == nil {
		rec.ByModel = make(map[string]*ModelUsageRecord)
	}
	addModelUsage(rec.ByModel, family, modelKey, input, output, cacheRead, cacheWrite, cost)

	hr := s.getHour()
	hr.InputTokens += input
	hr.OutputTokens += output
	hr.CachedTokens += cacheRead
	hr.CacheWriteTokens += cacheWrite
	if hr.ByModel == nil {
		hr.ByModel = make(map[string]*ModelUsageRecord)
	}
	addModelUsage(hr.ByModel, family, modelKey, input, output, cacheRead, cacheWrite, cost)
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

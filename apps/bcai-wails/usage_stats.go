package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DailyRecord 单日用量记录
type DailyRecord struct {
	Date          string  `json:"date"` // "2026-05-22"
	InputTokens   int64   `json:"inputTokens"`
	OutputTokens  int64   `json:"outputTokens"`
	CachedTokens  int64   `json:"cachedTokens"`
	Requests      int64   `json:"requests"`
	Errors        int64   `json:"errors"`
	Retries       int64   `json:"retries"`
	Generations   int64   `json:"generations"`
	SavedMoneyUSD float64 `json:"savedMoneyUSD"`
}

// HourlyRecord 每小时用量记录
type HourlyRecord struct {
	Hour         string `json:"hour"` // "15" (0-23)
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
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

// AddTokens 添加 token 用量。family(claude/gemini/gpt)决定省钱折算价,
// 省钱金额按本次增量 in/out * 家族单价累加(不再整段重算单一价)。
func (s *UsageStatsStore) AddTokens(family string, input, output, cached int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.getToday()
	rec.InputTokens += input
	rec.OutputTokens += output
	rec.CachedTokens += cached
	inP, outP := priceFor(family)
	rec.SavedMoneyUSD += float64(input)/1_000_000.0*inP + float64(output)/1_000_000.0*outP
	// 小时记录
	hr := s.getHour()
	hr.InputTokens += input
	hr.OutputTokens += output
	s.dirty = true
}

// AddRequest 添加请求计数
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
	return *s.getToday()
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
			result = append(result, *rec)
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
			result[h] = *rec
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

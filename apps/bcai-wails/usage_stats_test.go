package main

import "testing"

func TestAddTokensSavedMoneyPerFamily(t *testing.T) {
	s := &UsageStatsStore{Records: map[string]*DailyRecord{}, HourlyRecords: map[string]*HourlyRecord{}}
	s.AddTokens("claude", 1_000_000, 200_000, 0) // 1M*$3 + 0.2M*$15 = 3 + 3 = 6
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 6 {
		t.Fatalf("claude saved = %v, want 6", got)
	}
	s.AddTokens("gemini", 1_000_000, 0, 0) // +1M*$1.25 = +1.25 → 7.25
	if got := s.GetTodayRecord().SavedMoneyUSD; got != 7.25 {
		t.Fatalf("after gemini saved = %v, want 7.25", got)
	}
}

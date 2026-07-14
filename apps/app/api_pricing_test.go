package main

import (
	"math"
	"testing"
	"time"
)

func TestAPIValueUsesExactModelAndContextPrices(t *testing.T) {
	at := time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC)
	sol := calculateAPIValue("codex", "gpt-5.6-sol", "standard", 100_000,
		593_410, 102_560, 24_470_000, 0, 0, at)
	if math.Abs(sol.USD-18.27885) > 1e-9 || sol.Quality != "exact" {
		t.Fatalf("sol = %+v, want $18.27885 exact", sol)
	}
	luna := calculateAPIValue("codex", "gpt-5.6-luna", "standard", 100_000,
		1_000_000, 0, 0, 0, 0, at)
	terra := calculateAPIValue("codex", "gpt-5.6-terra", "standard", 100_000,
		1_000_000, 0, 0, 0, 0, at)
	if luna.USD != 1 || terra.USD != 2.5 {
		t.Fatalf("model-specific values lost: luna=%+v terra=%+v", luna, terra)
	}
	long := calculateAPIValue("codex", "gpt-5.6-sol", "standard", 300_000,
		1_000_000, 0, 0, 0, 0, at)
	if long.USD != 10 || long.ContextTier != "long" {
		t.Fatalf("long context = %+v", long)
	}
	boundary := calculateAPIValue("codex", "gpt-5.6-sol", "standard", 272_000,
		1_000_000, 0, 0, 0, 0, at)
	if boundary.USD != 5 || boundary.ContextTier != "short" {
		t.Fatalf("272k boundary = %+v, want short-context pricing", boundary)
	}
	mini := calculateAPIValue("codex", "gpt-5.4-mini", "standard", 1_000_000,
		1_000_000, 0, 0, 0, 0, at)
	if mini.USD != 0.75 || mini.Quality != "exact" {
		t.Fatalf("mini context = %+v, want published flat price", mini)
	}
}

func TestAPIValuePriorityAndClaudeCacheTTL(t *testing.T) {
	at := time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC)
	priority := calculateAPIValue("codex", "gpt-5.6-sol", "priority", 100_000,
		1_000_000, 0, 0, 0, 0, at)
	if priority.USD != 10 || priority.PricingMode != "priority" {
		t.Fatalf("priority = %+v", priority)
	}
	unsupported := calculateAPIValue("codex", "gpt-5.6-sol", "priority", 300_000,
		1_000_000, 0, 0, 0, 0, at)
	if unsupported.USD != 12.5 || unsupported.Quality != "unsupported-context" {
		t.Fatalf("priority long fallback = %+v", unsupported)
	}
	missingMode := calculateAPIValue("codex", "gpt-5.3-codex", "priority", 100_000,
		1_000_000, 0, 0, 0, 0, at)
	if missingMode.USD <= 0 || missingMode.Quality != "conservative-fallback" {
		t.Fatalf("unpublished mode fallback = %+v", missingMode)
	}
	claude := calculateAPIValue("anthropic", "claude-opus-4-8", "standard", 0,
		0, 0, 0, 1_000_000, 1_000_000, at)
	if claude.USD != 16.25 {
		t.Fatalf("claude cache TTL value = %+v", claude)
	}
}

func TestAPIValueUnknownModelIsExplicitlyConservative(t *testing.T) {
	v := calculateAPIValue("codex", "gpt-future", "standard", 0,
		1_000_000, 0, 0, 0, 0, time.Now())
	if v.USD < 5 || v.Quality != "conservative-fallback" {
		t.Fatalf("unknown fallback = %+v", v)
	}
}

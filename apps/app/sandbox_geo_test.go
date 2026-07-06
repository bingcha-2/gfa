package main

import "testing"

func TestNormalizeTimezone(t *testing.T) {
	cases := map[string]string{
		"America/Los_Angeles": "America/Los_Angeles",
		"America/New_York":     "America/New_York",
		"Asia/Shanghai":        "Asia/Shanghai",
		"":                     "America/New_York", // 空 → 默认
		"garbage":              "America/New_York", // 非 IANA → 默认
		"  America/Denver  ":   "America/Denver",   // trim
	}
	for in, want := range cases {
		if got := normalizeTimezone(in); got != want {
			t.Errorf("normalizeTimezone(%q)=%q want %q", in, got, want)
		}
	}
}

func TestProbeExitTimezoneSuppressed(t *testing.T) {
	// 抑制态(go test)不触网络,回退默认。
	got, err := probeExitTimezone("http://user:pass@1.2.3.4:8080")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "America/New_York" {
		t.Errorf("suppressed probe should return default, got %q", got)
	}
}

func TestProbeExitTimezoneEmptyProxy(t *testing.T) {
	got, _ := probeExitTimezone("")
	if got != "America/New_York" {
		t.Errorf("empty proxy should return default, got %q", got)
	}
}

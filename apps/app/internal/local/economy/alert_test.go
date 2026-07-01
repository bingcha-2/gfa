package economy

import (
	"path/filepath"
	"testing"
)

func TestShouldAlertDisabledNeverFires(t *testing.T) {
	cfg := AlertConfig{Enabled: false, ThresholdPct: 20}
	acc := AccountView{HasQuota: true, HourlyPercent: 5, WeeklyPercent: 5}
	res := ShouldAlert(cfg, acc)
	if res.Alert {
		t.Fatalf("disabled config must never alert")
	}
}

func TestShouldAlertFiresWhenBelowOrEqualThreshold(t *testing.T) {
	cfg := AlertConfig{Enabled: true, ThresholdPct: 20}
	acc := AccountView{HasQuota: true, HourlyPercent: 20, WeeklyPercent: 90}
	res := ShouldAlert(cfg, acc)
	if !res.Alert {
		t.Fatalf("percentage == threshold must alert (remaining quota semantics)")
	}
	if res.LowestPercentage != 20 {
		t.Fatalf("lowest percentage want 20, got %d", res.LowestPercentage)
	}
	if len(res.LowModels) != 1 || res.LowModels[0] != "primary_window" {
		t.Fatalf("want primary_window flagged, got %+v", res.LowModels)
	}
}

func TestShouldAlertSilentWhenAboveThreshold(t *testing.T) {
	cfg := AlertConfig{Enabled: true, ThresholdPct: 20}
	acc := AccountView{HasQuota: true, HourlyPercent: 21, WeeklyPercent: 90}
	if ShouldAlert(cfg, acc).Alert {
		t.Fatalf("strictly above threshold must not alert")
	}
}

func TestShouldAlertNoQuotaSilent(t *testing.T) {
	cfg := AlertConfig{Enabled: true, ThresholdPct: 50}
	if ShouldAlert(cfg, AccountView{HasQuota: false}).Alert {
		t.Fatalf("account without quota must not alert")
	}
}

func TestShouldAlertClampsThreshold(t *testing.T) {
	// threshold 150 -> clamp 100; remaining 100 <= 100 fires.
	cfg := AlertConfig{Enabled: true, ThresholdPct: 150}
	acc := AccountView{HasQuota: true, HourlyPercent: 100, WeeklyPercent: 100}
	if !ShouldAlert(cfg, acc).Alert {
		t.Fatalf("threshold clamps to 100 and must fire at full remaining")
	}
}

func TestAlertConfigStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewAlertStore(dir)

	got := s.Load()
	if got.Enabled {
		t.Fatalf("default alert config must be disabled, got %+v", got)
	}
	if got.ThresholdPct != defaultAlertThresholdPct {
		t.Fatalf("default threshold want %d, got %d", defaultAlertThresholdPct, got.ThresholdPct)
	}

	if err := s.Save(AlertConfig{Enabled: true, ThresholdPct: 35}); err != nil {
		t.Fatalf("save: %v", err)
	}
	reloaded := NewAlertStore(dir).Load()
	if !reloaded.Enabled || reloaded.ThresholdPct != 35 {
		t.Fatalf("round trip mismatch: %+v", reloaded)
	}
	if _, err := filepath.Abs(filepath.Join(dir, alertConfigFile)); err != nil {
		t.Fatalf("path: %v", err)
	}
}

func TestAlertConfigStoreClampsOnLoad(t *testing.T) {
	dir := t.TempDir()
	s := NewAlertStore(dir)
	if err := s.Save(AlertConfig{Enabled: true, ThresholdPct: 999}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := s.Load().ThresholdPct; got != 100 {
		t.Fatalf("threshold must clamp to 100 on load, got %d", got)
	}
}

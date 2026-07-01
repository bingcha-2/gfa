package economy

import "testing"

func TestQuotaMetricsPrefersPresentWindows(t *testing.T) {
	hourlyOnly := AccountView{
		HasQuota:            true,
		HourlyPercent:       40,
		WeeklyPercent:       90,
		HourlyWindowPresent: boolPtr(true),
		WeeklyWindowPresent: boolPtr(false),
	}
	metrics := hourlyOnly.quotaMetrics()
	if len(metrics) != 1 {
		t.Fatalf("want 1 metric when only hourly present, got %d", len(metrics))
	}
	if metrics[0].key != metricPrimary || metrics[0].percentage != 40 {
		t.Fatalf("unexpected metric %+v", metrics[0])
	}
}

func TestQuotaMetricsBothWhenNoPresenceFlags(t *testing.T) {
	a := AccountView{HasQuota: true, HourlyPercent: 30, WeeklyPercent: 80}
	metrics := a.quotaMetrics()
	if len(metrics) != 2 {
		t.Fatalf("want 2 metrics with no presence flags, got %d", len(metrics))
	}
	if metrics[0].percentage != 30 || metrics[1].percentage != 80 {
		t.Fatalf("unexpected percentages %+v", metrics)
	}
}

func TestQuotaMetricsClampsToRange(t *testing.T) {
	a := AccountView{HasQuota: true, HourlyPercent: 250, WeeklyPercent: -10}
	metrics := a.quotaMetrics()
	if metrics[0].percentage != 100 {
		t.Fatalf("hourly should clamp to 100, got %d", metrics[0].percentage)
	}
	if metrics[1].percentage != 0 {
		t.Fatalf("weekly should clamp to 0, got %d", metrics[1].percentage)
	}
}

func TestQuotaMetricsEmptyWhenNoQuota(t *testing.T) {
	a := AccountView{HasQuota: false}
	if got := a.quotaMetrics(); len(got) != 0 {
		t.Fatalf("want no metrics when no quota, got %d", len(got))
	}
}

func boolPtr(b bool) *bool { return &b }

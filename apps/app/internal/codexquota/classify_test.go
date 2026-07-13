package codexquota

import "testing"

func seconds(v int64) *int64 { return &v }

func TestClassifyWindows(t *testing.T) {
	tests := []struct {
		name                string
		primary, secondary  Slot
		primaryKind, second Kind
		hourly, weekly      Presence
	}{
		{
			name:        "weekly moved into primary",
			primary:     Slot{Exists: true, LimitWindowSeconds: seconds(WeeklyWindowSeconds)},
			primaryKind: Weekly, second: Unknown,
			hourly: Absent, weekly: Present,
		},
		{
			name:        "recognized two windows swapped",
			primary:     Slot{Exists: true, LimitWindowSeconds: seconds(WeeklyWindowSeconds)},
			secondary:   Slot{Exists: true, LimitWindowSeconds: seconds(HourlyWindowSeconds)},
			primaryKind: Weekly, second: Hourly,
			hourly: Present, weekly: Present,
		},
		{
			name:        "legacy positions remain compatible but missing side unknown",
			primary:     Slot{Exists: true},
			primaryKind: Hourly, second: Unknown,
			hourly: Present, weekly: PresenceUnknown,
		},
		{
			name:        "empty response keeps both unknown",
			primaryKind: Unknown, second: Unknown,
			hourly: PresenceUnknown, weekly: PresenceUnknown,
		},
		{
			name:        "unrecognized duration prevents absence claims",
			primary:     Slot{Exists: true, LimitWindowSeconds: seconds(24 * 60 * 60)},
			primaryKind: Unknown, second: Unknown,
			hourly: PresenceUnknown, weekly: PresenceUnknown,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyWindows(tt.primary, tt.secondary)
			if got.Primary != tt.primaryKind || got.Secondary != tt.second || got.Hourly != tt.hourly || got.Weekly != tt.weekly {
				t.Fatalf("classification = %+v", got)
			}
		})
	}
}

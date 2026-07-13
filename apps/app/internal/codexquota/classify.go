// Package codexquota contains the provider-neutral classification of Codex
// quota windows. Parsing percentages and reset times stays in each caller.
package codexquota

const (
	HourlyWindowSeconds int64 = 5 * 60 * 60
	WeeklyWindowSeconds int64 = 7 * 24 * 60 * 60
)

type Kind uint8

const (
	Unknown Kind = iota
	Hourly
	Weekly
)

type Presence uint8

const (
	PresenceUnknown Presence = iota
	Absent
	Present
)

type Slot struct {
	Exists             bool
	LimitWindowSeconds *int64
}

type Classification struct {
	Primary   Kind
	Secondary Kind
	Hourly    Presence
	Weekly    Presence
}

// ClassifyWindows prefers self-describing durations. A duration-less legacy
// slot keeps its positional meaning, but makes the missing counterpart unknown.
func ClassifyWindows(primary, secondary Slot) Classification {
	result := Classification{}
	ambiguous := false
	classified := false
	present := func(kind Kind) {
		if kind == Hourly {
			result.Hourly = Present
		} else if kind == Weekly {
			result.Weekly = Present
		}
	}
	for index, slot := range []Slot{primary, secondary} {
		if !slot.Exists {
			continue
		}
		kind := Unknown
		if slot.LimitWindowSeconds == nil {
			if index == 0 {
				kind = Hourly
			} else {
				kind = Weekly
			}
			ambiguous = true
		} else {
			switch *slot.LimitWindowSeconds {
			case HourlyWindowSeconds:
				kind = Hourly
				classified = true
			case WeeklyWindowSeconds:
				kind = Weekly
				classified = true
			default:
				ambiguous = true
			}
		}
		if index == 0 {
			result.Primary = kind
		} else {
			result.Secondary = kind
		}
		present(kind)
	}
	if classified && !ambiguous {
		if result.Hourly == PresenceUnknown {
			result.Hourly = Absent
		}
		if result.Weekly == PresenceUnknown {
			result.Weekly = Absent
		}
	}
	return result
}

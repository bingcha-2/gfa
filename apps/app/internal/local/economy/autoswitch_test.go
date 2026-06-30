package economy

import "testing"

func mkAcc(id string, hourly, weekly int) AccountView {
	return AccountView{ID: id, HasQuota: true, HourlyPercent: hourly, WeeklyPercent: weekly}
}

func TestPickAutoSwitchNoneWhenDisabled(t *testing.T) {
	cfg := SwitchConfig{Enabled: false, ThresholdPct: 20}
	cur := mkAcc("a", 5, 5)
	accounts := []AccountView{cur, mkAcc("b", 90, 90)}
	if got := PickAutoSwitch(cfg, accounts, "a"); got != nil {
		t.Fatalf("disabled must return nil, got %+v", got)
	}
}

func TestPickAutoSwitchNoneWhenCurrentHealthy(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	accounts := []AccountView{mkAcc("a", 80, 80), mkAcc("b", 90, 90)}
	if got := PickAutoSwitch(cfg, accounts, "a"); got != nil {
		t.Fatalf("healthy current must not switch, got %+v", got)
	}
}

func TestPickAutoSwitchPicksCandidateWhenCurrentOverThreshold(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	accounts := []AccountView{
		mkAcc("a", 10, 90), // current, hourly below threshold
		mkAcc("b", 90, 90),
	}
	got := PickAutoSwitch(cfg, accounts, "a")
	if got == nil || got.ID != "b" {
		t.Fatalf("want candidate b, got %+v", got)
	}
}

func TestPickAutoSwitchRanksByMargin(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	accounts := []AccountView{
		mkAcc("cur", 5, 5),
		mkAcc("low", 25, 25),  // min margin 5
		mkAcc("high", 80, 70), // min margin 50 -> winner
	}
	got := PickAutoSwitch(cfg, accounts, "cur")
	if got == nil || got.ID != "high" {
		t.Fatalf("want highest-margin candidate high, got %+v", got)
	}
}

func TestPickAutoSwitchExcludesCandidatesAtOrBelowThreshold(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	accounts := []AccountView{
		mkAcc("cur", 5, 5),
		mkAcc("b", 20, 90), // hourly == threshold -> not a valid candidate
	}
	if got := PickAutoSwitch(cfg, accounts, "cur"); got != nil {
		t.Fatalf("candidate at threshold must be excluded, got %+v", got)
	}
}

func TestPickAutoSwitchCoolingCandidateExcluded(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	cooling := mkAcc("b", 90, 90)
	cooling.Cooling = true
	accounts := []AccountView{mkAcc("cur", 5, 5), cooling}
	if got := PickAutoSwitch(cfg, accounts, "cur"); got != nil {
		t.Fatalf("cooling candidate must be excluded, got %+v", got)
	}
}

func TestPickAutoSwitchCoolingCurrentTriggersSwitch(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	cur := mkAcc("cur", 80, 80) // quota healthy but cooling -> still switch
	cur.Cooling = true
	accounts := []AccountView{cur, mkAcc("b", 90, 90)}
	got := PickAutoSwitch(cfg, accounts, "cur")
	if got == nil || got.ID != "b" {
		t.Fatalf("cooling current must switch to b, got %+v", got)
	}
}

func TestPickAutoSwitchTieBreaksByOldestLastUsed(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	older := mkAcc("older", 90, 90)
	older.LastUsedAt = 100
	newer := mkAcc("newer", 90, 90)
	newer.LastUsedAt = 999
	accounts := []AccountView{mkAcc("cur", 5, 5), newer, older}
	got := PickAutoSwitch(cfg, accounts, "cur")
	if got == nil || got.ID != "older" {
		t.Fatalf("tie should pick least-recently-used, got %+v", got)
	}
}

func TestPickAutoSwitchScopeSelectedRestrictsCandidates(t *testing.T) {
	cfg := SwitchConfig{
		Enabled:            true,
		ThresholdPct:       20,
		ScopeMode:          ScopeSelected,
		SelectedAccountIDs: []string{"cur", "allowed"},
	}
	accounts := []AccountView{
		mkAcc("cur", 5, 5),
		mkAcc("blocked-scope", 95, 95),
		mkAcc("allowed", 90, 90),
	}
	got := PickAutoSwitch(cfg, accounts, "cur")
	if got == nil || got.ID != "allowed" {
		t.Fatalf("selected scope must pick allowed, got %+v", got)
	}
}

func TestPickAutoSwitchCurrentOutOfScopeNoSwitch(t *testing.T) {
	cfg := SwitchConfig{
		Enabled:            true,
		ThresholdPct:       20,
		ScopeMode:          ScopeSelected,
		SelectedAccountIDs: []string{"other"},
	}
	accounts := []AccountView{mkAcc("cur", 5, 5), mkAcc("other", 90, 90)}
	if got := PickAutoSwitch(cfg, accounts, "cur"); got != nil {
		t.Fatalf("current out of monitored scope must not switch, got %+v", got)
	}
}

func TestPickAutoSwitchNoCandidatesReturnsNil(t *testing.T) {
	cfg := SwitchConfig{Enabled: true, ThresholdPct: 20}
	accounts := []AccountView{mkAcc("cur", 5, 5), mkAcc("b", 10, 10)}
	if got := PickAutoSwitch(cfg, accounts, "cur"); got != nil {
		t.Fatalf("no healthy candidate must return nil, got %+v", got)
	}
}

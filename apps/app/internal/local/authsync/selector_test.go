package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/routingcfg"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func opts() cliproxyexecutor.Options { return cliproxyexecutor.Options{} }

func mkAuth(id string, priority bool, remainingPct int) *coreauth.Auth {
	prio := "0"
	if priority {
		prio = "1"
	}
	return &coreauth.Auth{
		ID: id,
		Attributes: map[string]string{
			"priority":      prio,
			"remaining_pct": itoa(remainingPct),
		},
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func TestSelector_EmptyReturnsError(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPriority)
	if _, err := s.Pick(context.Background(), "codex", "m", opts(), nil); err == nil {
		t.Fatal("expected error on empty auths")
	}
}

func TestSelector_PriorityPicksPriorityAccount(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPriority)
	auths := []*coreauth.Auth{mkAuth("a", false, 10), mkAuth("b", true, 5), mkAuth("c", false, 90)}
	got, err := s.Pick(context.Background(), "codex", "m", opts(), auths)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "b" {
		t.Fatalf("priority pick = %s, want b", got.ID)
	}
}

func TestSelector_PriorityFallsBackToFirst(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPriority)
	auths := []*coreauth.Auth{mkAuth("a", false, 10), mkAuth("b", false, 5)}
	got, _ := s.Pick(context.Background(), "codex", "m", opts(), auths)
	if got.ID != "a" {
		t.Fatalf("priority fallback = %s, want a (first)", got.ID)
	}
}

func TestSelector_FairPicksHighestRemainingQuota(t *testing.T) {
	s := NewSelector(routingcfg.StrategyFair)
	auths := []*coreauth.Auth{mkAuth("a", false, 10), mkAuth("b", true, 5), mkAuth("c", false, 90)}
	got, _ := s.Pick(context.Background(), "codex", "m", opts(), auths)
	if got.ID != "c" {
		t.Fatalf("fair pick = %s, want c (90%% remaining)", got.ID)
	}
}

func mkAuthPlan(id, plan string, remainingPct int) *coreauth.Auth {
	return &coreauth.Auth{
		ID: id,
		Attributes: map[string]string{
			"priority":      "0",
			"plan_type":     plan,
			"remaining_pct": itoa(remainingPct),
		},
	}
}

func pickID(t *testing.T, s *Selector, auths []*coreauth.Auth) string {
	t.Helper()
	got, err := s.Pick(context.Background(), "codex", "m", opts(), auths)
	if err != nil {
		t.Fatal(err)
	}
	return got.ID
}

func TestSelector_QuotaLowFirstDrainsLowestKnown(t *testing.T) {
	s := NewSelector(routingcfg.StrategyQuotaLowFirst)
	// b 剩 5(最低)应先用;c 未知额度(-1)不当成最低,排最后。
	auths := []*coreauth.Auth{mkAuthPlan("a", "pro", 40), mkAuthPlan("b", "pro", 5), mkAuthPlan("c", "pro", -1)}
	if got := pickID(t, s, auths); got != "b" {
		t.Fatalf("quota-low-first = %s, want b(剩 5 最低)", got)
	}
}

func TestSelector_PlanHighFirstPrefersHigherTier(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPlanHighFirst)
	auths := []*coreauth.Auth{mkAuthPlan("a", "plus", 90), mkAuthPlan("b", "team", 10), mkAuthPlan("c", "pro", 50)}
	if got := pickID(t, s, auths); got != "b" {
		t.Fatalf("plan-high-first = %s, want b(team 最高档)", got)
	}
}

func TestSelector_PlanLowFirstPrefersLowerTierUnknownLast(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPlanLowFirst)
	// a free(最低档)应先用;c 未知套餐不当成最低档,排最后。
	auths := []*coreauth.Auth{mkAuthPlan("c", "", 90), mkAuthPlan("a", "free", 10), mkAuthPlan("b", "pro", 50)}
	if got := pickID(t, s, auths); got != "a" {
		t.Fatalf("plan-low-first = %s, want a(free 最低档)", got)
	}
}

func TestSelector_RoundRobinRotates(t *testing.T) {
	s := NewSelector(routingcfg.StrategyRoundRobin)
	auths := []*coreauth.Auth{mkAuth("a", false, 0), mkAuth("b", false, 0), mkAuth("c", false, 0)}
	var seq []string
	for i := 0; i < 4; i++ {
		got, _ := s.Pick(context.Background(), "codex", "m", opts(), auths)
		seq = append(seq, got.ID)
	}
	// 轮询:a,b,c,a(回绕)。
	want := []string{"a", "b", "c", "a"}
	for i := range want {
		if seq[i] != want[i] {
			t.Fatalf("round-robin seq = %v, want %v", seq, want)
		}
	}
}

func TestSelector_SetStrategySwitchesBehavior(t *testing.T) {
	s := NewSelector(routingcfg.StrategyPriority)
	auths := []*coreauth.Auth{mkAuth("a", false, 10), mkAuth("c", false, 90)}
	got, _ := s.Pick(context.Background(), "codex", "m", opts(), auths)
	if got.ID != "a" {
		t.Fatalf("priority pick = %s, want a", got.ID)
	}
	s.SetStrategy(routingcfg.StrategyFair)
	got, _ = s.Pick(context.Background(), "codex", "m", opts(), auths)
	if got.ID != "c" {
		t.Fatalf("after switch to fair, pick = %s, want c", got.ID)
	}
}

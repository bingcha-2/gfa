package main

import (
	"errors"
	"math"
	"strings"
	"testing"
)

func intPointer(value int) *int { return &value }

func TestBuildCodexAppLaunchPlan(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		plan, err := buildCodexAppLaunchPlan(false, false, func() (int, error) {
			t.Fatal("disabled plan must not reserve a port")
			return 0, nil
		})
		if err != nil || len(plan.Args) != 0 || plan.CDPPort != 0 || plan.Branding {
			t.Fatalf("disabled plan = %+v err=%v", plan, err)
		}
	})

	t.Run("automatic branding uses ephemeral loopback port", func(t *testing.T) {
		plan, err := buildCodexAppLaunchPlan(false, true, func() (int, error) { return 45678, nil })
		if err != nil {
			t.Fatal(err)
		}
		if plan.CDPPort != 45678 || !plan.Branding {
			t.Fatalf("branding plan = %+v", plan)
		}
		joined := strings.Join(plan.Args, " ")
		for _, want := range []string{"--remote-debugging-address=127.0.0.1", "--remote-debugging-port=45678"} {
			if !strings.Contains(joined, want) {
				t.Fatalf("launch args missing %q: %v", want, plan.Args)
			}
		}
	})

	t.Run("manual skin channel is reused", func(t *testing.T) {
		plan, err := buildCodexAppLaunchPlan(true, true, func() (int, error) {
			t.Fatal("skin channel should not reserve another port")
			return 0, nil
		})
		if err != nil || plan.CDPPort != codexSkinChannelPort || !plan.Branding {
			t.Fatalf("skin+branding plan = %+v err=%v", plan, err)
		}
	})

	t.Run("port allocation failure is reported", func(t *testing.T) {
		_, err := buildCodexAppLaunchPlan(false, true, func() (int, error) {
			return 0, errors.New("no port")
		})
		if err == nil {
			t.Fatal("expected reserve error")
		}
	})
}

func TestQuotaRemainingPercentForCodexApp(t *testing.T) {
	cases := []struct {
		used, limit float64
		want        int
	}{
		{used: 18, limit: 100, want: 82},
		{used: 1, limit: 3, want: 67},
		{used: 120, limit: 100, want: 0},
		{used: 0, limit: 0, want: 100},
		{used: -5, limit: 100, want: 100},
		{used: math.NaN(), limit: 100, want: 100},
		{used: 5, limit: math.Inf(1), want: 100},
	}
	for _, test := range cases {
		if got := quotaRemainingPercent(test.used, test.limit); got == nil || *got != test.want {
			t.Fatalf("remaining(%v/%v) = %v, want %d", test.used, test.limit, got, test.want)
		}
	}
}

func TestCodexAppQuotaUsesDisplayedSubscriptionSnapshot(t *testing.T) {
	view := codexAppQuotaViewFromSubscriptions([]SubscriptionSnapshot{
		{
			Id:       "later",
			Priority: 2,
			UsdQuotaByProduct: map[string]SubscriptionProductUsdQuota{
				"codex": {Weekly: &SubscriptionUsdQuotaWindow{Used: 9, Limit: 100}},
			},
		},
		{
			Id:       "displayed-first",
			Priority: 1,
			UsdQuotaByProduct: map[string]SubscriptionProductUsdQuota{
				"codex": {Weekly: &SubscriptionUsdQuotaWindow{Used: 10, Limit: 100}},
			},
		},
	})
	if view.Weekly == nil || *view.Weekly != 90 {
		t.Fatalf("weekly = %v, want displayed subscription value 90", view.Weekly)
	}
}

func TestCodexRemoteBrandingScriptContainsAvatarAndQuota(t *testing.T) {
	script := codexRemoteBrandingScript(codexAppQuotaView{
		Weekly: intPointer(64),
	})
	for _, want := range []string{
		`const brandName = "冰茶 AI"`,
		`const weeklyPercent = 64`,
		`data:image/png;base64,`,
		`data-bcai-remote-avatar`,
		`data-bcai-remote-quota`,
		`normalized(element.textContent) === brandName`,
		`root.avatarLayoutVersion = 2`,
		`insertBefore(avatar, icon)`,
		`background:#10b981`,
		`>本周 ' + Math.round(weeklyPercent)`,
		`const nextHtml = fields.join('')`,
		`MutationObserver`,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("branding script missing %q", want)
		}
	}
	if strings.Contains(script, "https://") {
		t.Fatal("branding payload must not load remote image or script resources")
	}
	if strings.Contains(script, "fiveHourPercent") || strings.Contains(script, ">5h ") {
		t.Fatal("Codex 订阅不再展示空置的 5h 额度")
	}
	if strings.Contains(script, "position:absolute;left:50%;top:50%;width:24px") {
		t.Fatal("头像不得再相对整行 Provider 按钮居中定位")
	}
}

func TestCodexRemoteBrandingScriptHidesUnknownQuota(t *testing.T) {
	script := codexRemoteBrandingScript(codexAppQuotaView{})
	for _, want := range []string{
		"const weeklyPercent = null",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("unknown quota should be null, missing %q", want)
		}
	}
}

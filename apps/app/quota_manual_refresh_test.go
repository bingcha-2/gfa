package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func manualQuotaResponse(used float64) map[string]interface{} {
	return map[string]interface{}{"subscriptions": []interface{}{map[string]interface{}{
		"id": "sub-manual", "status": "ACTIVE", "products": []interface{}{"codex"},
		"usdQuotaByProduct": map[string]interface{}{"codex": map[string]interface{}{
			"fiveHour": map[string]interface{}{"used": used, "limit": 100.0, "resetAt": "2030-01-01T05:00:00Z"},
			"weekly":   map[string]interface{}{"used": 90.0, "limit": 1000.0, "resetAt": "2030-01-07T05:00:00Z"},
		}},
	}}}
}

func TestManualQuotaRefresh(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		first, second          float64
		calls                  int
		failSecond, background bool
	}{
		{name: "large drop confirmed with new usage", first: 0, second: 2, calls: 2},
		{name: "just over five", first: 74.99, second: 75.1, calls: 2},
		{name: "exactly five", first: 75, second: 75, calls: 2},
		{name: "small drop", first: 79, calls: 1},
		{name: "usage increased", first: 81, calls: 1},
		{name: "confirmation restores old value", first: 0, second: 80, calls: 2},
		{name: "confirmation failed", first: 0, calls: 2, failSecond: true},
		{name: "background unchanged", first: 0, calls: 1, background: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oldDir, oldBase := origConfigDir, authBaseURL
			origConfigDir = t.TempDir()
			t.Cleanup(func() { origConfigDir, authBaseURL = oldDir, oldBase })
			seedLoggedInConfig(t, "manual-token")
			cfg := LoadConfig()
			cfg.Subscriptions, _ = parseHeartbeatSubscriptions(manualQuotaResponse(10))
			if err := SaveConfig(cfg); err != nil {
				t.Fatal(err)
			}
			l := GetLeaser()
			l.ClearAccessKeyStatus()
			t.Cleanup(l.ClearAccessKeyStatus)
			initial := manualQuotaResponse(80)["subscriptions"].([]interface{})[0].(map[string]interface{})
			l.syncFromServer(initial)
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/app/heartbeat" {
					t.Errorf("unexpected endpoint %s", r.URL.Path)
				}
				var payload map[string]interface{}
				_ = json.NewDecoder(r.Body).Decode(&payload)
				if !tc.background && payload["refreshUsage"] != true {
					t.Error("manual request must bypass usage cache")
				}
				if calls == 2 && tc.failSecond {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				used := tc.first
				if calls > 1 {
					used = tc.second
				}
				_ = json.NewEncoder(w).Encode(manualQuotaResponse(used))
			}))
			defer srv.Close()
			authBaseURL = srv.URL
			app := &App{}
			var err error
			if tc.background {
				_, err = app.HeartbeatCheck()
			} else {
				_, err = app.RefreshUsageSummary()
			}
			if (err != nil) != tc.failSecond {
				t.Fatalf("unexpected error: %v", err)
			}
			if calls != tc.calls {
				t.Fatalf("requests=%d, want %d", calls, tc.calls)
			}
			wantSaved, wantCache := tc.first, tc.first
			if tc.calls == 2 {
				wantSaved, wantCache = tc.second, tc.second
			}
			if tc.failSecond {
				wantSaved, wantCache = 10, 80
			}
			if tc.background {
				wantCache = 80
			}
			saved := LoadConfig().Subscriptions[0].UsdQuotaByProduct["codex"]
			if saved.FiveHour.Used != wantSaved {
				t.Fatalf("saved used=%v, want %v", saved.FiveHour.Used, wantSaved)
			}
			status := l.GetStatus()["accessKeyStatus"].(map[string]interface{})
			quota := parseSubscriptionUsdQuotaByProduct(status["usdQuotaByProduct"].(map[string]interface{}))["codex"]
			if quota.FiveHour.Used != wantCache {
				t.Fatalf("GetStats cache used=%v, want %v", quota.FiveHour.Used, wantCache)
			}
			if quota.Weekly.Used != 90 {
				t.Fatal("weekly usage changed")
			}
		})
	}
}

func TestManualQuotaConfirmationUsesSubscriptionProductAndScope(t *testing.T) {
	previous := []SubscriptionSnapshot{{Id: "a", UsdQuotaByProduct: map[string]SubscriptionProductUsdQuota{
		"codex": {FiveHour: &SubscriptionUsdQuotaWindow{Used: 80}, Weekly: &SubscriptionUsdQuotaWindow{Used: 90}},
	}}}
	for _, tc := range []struct {
		name, id, product string
		fiveHour, weekly  float64
		want              bool
	}{
		{"weekly drop", "a", "codex", 80, 0, true},
		{"other subscription", "b", "codex", 0, 0, false},
		{"other product", "a", "anthropic", 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := []SubscriptionSnapshot{{Id: tc.id, UsdQuotaByProduct: map[string]SubscriptionProductUsdQuota{
				tc.product: {FiveHour: &SubscriptionUsdQuotaWindow{Used: tc.fiveHour}, Weekly: &SubscriptionUsdQuotaWindow{Used: tc.weekly}},
			}}}
			if got := quotaUsageDropped(previous, next); got != tc.want {
				t.Fatalf("confirmation=%v", got)
			}
		})
	}
}

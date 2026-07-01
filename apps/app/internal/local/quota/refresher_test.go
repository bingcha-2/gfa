package quota

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

func TestCodexRefresher_TokenExpired(t *testing.T) {
	r := NewCodexRefresher(CodexEndpoints{})
	past := &account.Account{AccessToken: jwtWith(t, map[string]any{"exp": time.Now().Add(-time.Hour).Unix()})}
	future := &account.Account{AccessToken: jwtWith(t, map[string]any{"exp": time.Now().Add(time.Hour).Unix()})}
	if !r.TokenExpired(past) {
		t.Fatal("past token should be expired")
	}
	if r.TokenExpired(future) {
		t.Fatal("future token should not be expired")
	}
}

func TestCodexRefresher_RefreshToken_WritesBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id_token": "nid", "access_token": "nacc", "refresh_token": "nref",
		})
	}))
	defer srv.Close()
	r := NewCodexRefresher(CodexEndpoints{TokenURL: srv.URL + "/t"})
	a := &account.Account{IDToken: "oid", AccessToken: "oacc", RefreshToken: "oref"}
	if err := r.RefreshToken(a); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if a.AccessToken != "nacc" || a.RefreshToken != "nref" || a.IDToken != "nid" {
		t.Fatalf("token not written back: %+v", a)
	}
}

func TestAntigravityRefresher_RefreshToken_WritesBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ag-new", "expires_in": 3600})
	}))
	defer srv.Close()
	r := NewAntigravityRefresher(AntigravityEndpoints{TokenURL: srv.URL + "/t"})
	a := &account.Account{AccessToken: "old", RefreshToken: "ref"}
	if err := r.RefreshToken(a); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if a.AccessToken != "ag-new" {
		t.Fatalf("access not written back: %+v", a)
	}
	if a.Expiry <= time.Now().Unix() {
		t.Fatalf("expiry not written back: %+v", a)
	}
}

// TestAntigravityRefresher_TokenExpired:用 account.Expiry(unix 秒)判,留 60s skew。
func TestAntigravityRefresher_TokenExpired(t *testing.T) {
	r := NewAntigravityRefresher(AntigravityEndpoints{})
	if !r.TokenExpired(&account.Account{Expiry: time.Now().Add(-time.Hour).Unix()}) {
		t.Fatal("past expiry should be expired")
	}
	if r.TokenExpired(&account.Account{Expiry: time.Now().Add(time.Hour).Unix()}) {
		t.Fatal("future expiry should not be expired")
	}
	// Expiry=0(未知)按未过期(不主动续约)。
	if r.TokenExpired(&account.Account{Expiry: 0}) {
		t.Fatal("unknown expiry should not be treated as expired")
	}
}

// TestNormalizeGeminiPlan:认得出的映射到 ULTRA/PRO/FREE;认不出的**保留真实 tier 串**,
// 绝不臆断 FREE(付费号误标 FREE 的坑);空 → ""(keep-prior)。
func TestNormalizeGeminiPlan(t *testing.T) {
	cases := map[string]string{
		"":              "",
		"ai-ultra-tier": "ULTRA",
		"pro-tier":      "PRO",
		"premium":       "PRO",
		"free-tier":     "FREE",
		"standard-tier": "FREE",
		"legacy-tier":   "legacy-tier", // 未知:原样,不冒充 FREE
		"enterprise":    "enterprise",
	}
	for in, want := range cases {
		if got := normalizeGeminiPlan(in); got != want {
			t.Fatalf("normalizeGeminiPlan(%q)=%q want %q", in, got, want)
		}
	}
}

// cloudCodeMux 造一个 mock Cloud Code 服务:loadCodeAssist / fetchAvailableModels /
// retrieveUserQuotaSummary 各回一段 body。onboard 处理器可选。
func cloudCodeMux(t *testing.T, loadBody, modelsBody, summaryBody string, onboard http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, loadCodeAssistPath):
			_, _ = w.Write([]byte(loadBody))
		case strings.HasSuffix(r.URL.Path, fetchModelsPath):
			_, _ = w.Write([]byte(modelsBody))
		case strings.HasSuffix(r.URL.Path, quotaSummaryPath):
			_, _ = w.Write([]byte(summaryBody))
		case strings.Contains(r.URL.Path, onboardUserPath) || strings.Contains(r.URL.Path, "/v1internal/operations/"):
			if onboard != nil {
				onboard(w, r)
				return
			}
			http.Error(w, "unexpected onboard", http.StatusInternalServerError)
		default:
			http.Error(w, "unexpected path "+r.URL.Path, http.StatusNotFound)
		}
	}))
}

func bucketKeys(res Result) map[string]account.QuotaBucket {
	out := map[string]account.QuotaBucket{}
	for _, b := range res.Buckets {
		out[b.Key] = b
	}
	return out
}

// TestAntigravityRefresher_FetchQuota_FourBuckets:summary 给全 4 桶(gemini/claude × 5h/周),
// 全部进 Result.Buckets;gemini-5h/gemini-weekly 兼容回填 Hourly/Weekly;tier 归一到 PlanType。
func TestAntigravityRefresher_FetchQuota_FourBuckets(t *testing.T) {
	load := `{"cloudaicompanionProject":"proj-1","paidTier":{"id":"free-tier"}}`
	// free 档:5h 有自己的 reset(非 0),原样透传,不触发非 free 的 >5h 覆盖。
	summary := `{"groups":[{"buckets":[
		{"bucketId":"gemini-5h","remainingFraction":0.42,"resetTime":1893456000},
		{"bucketId":"gemini-weekly","remainingFraction":0.80,"resetTime":1893456000},
		{"bucketId":"3p-5h","remainingFraction":0.55,"resetTime":1893456000},
		{"bucketId":"3p-weekly","remainingFraction":0.90,"resetTime":1893456000}
	]}]}`
	srv := cloudCodeMux(t, load, `{"models":{}}`, summary, nil)
	defer srv.Close()

	r := NewAntigravityRefresher(AntigravityEndpoints{CloudCodeBaseURL: srv.URL})
	a := &account.Account{AccessToken: "tok", ProjectID: "proj-1"}
	res, err := r.FetchQuota(a)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	if len(res.Buckets) != 4 {
		t.Fatalf("want 4 buckets, got %d: %+v", len(res.Buckets), res.Buckets)
	}
	bk := bucketKeys(res)
	if bk["gemini-5h"].Percent != 42 || bk["gemini-weekly"].Percent != 80 {
		t.Fatalf("gemini pct wrong: %+v", bk)
	}
	if bk["3p-5h"].Percent != 55 || bk["3p-weekly"].Percent != 90 {
		t.Fatalf("claude pct wrong: %+v", bk)
	}
	if bk["3p-5h"].Label == "" || bk["gemini-weekly"].Label == "" {
		t.Fatalf("labels missing: %+v", bk)
	}
	if !res.HourlyKnown || res.HourlyPercent != 42 || !res.WeeklyKnown || res.WeeklyPercent != 80 {
		t.Fatalf("compat hourly/weekly wrong: h=%d w=%d", res.HourlyPercent, res.WeeklyPercent)
	}
	if res.PlanType != "FREE" {
		t.Fatalf("planType=%q want FREE", res.PlanType)
	}
}

// TestAntigravityRefresher_FetchQuota_NonFreeFiveHourOverride:非 free 号,gemini-5h 的
// reset 远超 5h(周限额在压)→ 5h 显示满血、清 reset(照搬 cockpit)。
func TestAntigravityRefresher_FetchQuota_NonFreeFiveHourOverride(t *testing.T) {
	load := `{"cloudaicompanionProject":"proj-1","paidTier":{"id":"pro-tier"}}`
	summary := `{"groups":[{"buckets":[
		{"bucketId":"gemini-5h","remainingFraction":0.42,"resetTime":"2035-01-01T00:00:00Z"}
	]}]}`
	srv := cloudCodeMux(t, load, `{"models":{}}`, summary, nil)
	defer srv.Close()

	r := NewAntigravityRefresher(AntigravityEndpoints{CloudCodeBaseURL: srv.URL})
	a := &account.Account{AccessToken: "tok", ProjectID: "proj-1"}
	res, err := r.FetchQuota(a)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	g5 := bucketKeys(res)["gemini-5h"]
	if g5.Percent != 100 || g5.ResetAt != 0 {
		t.Fatalf("non-free >5h override failed: pct=%d reset=%d", g5.Percent, g5.ResetAt)
	}
}

// TestAntigravityRefresher_FetchQuota_FallbackToModels:summary 缺 gemini-5h,
// 由 fetchAvailableModels 的 per-model(gemini...high)回退补上 Gemini 5h(不再显示 0)。
func TestAntigravityRefresher_FetchQuota_FallbackToModels(t *testing.T) {
	load := `{"cloudaicompanionProject":"proj-1","paidTier":{"id":"free-tier"}}`
	models := `{"models":{
		"gemini-2.5-pro-high":{"quotaInfo":{"remainingFraction":0.33,"resetTime":"2030-01-01T00:00:00Z"}},
		"gemini-2.5-pro-low":{"quotaInfo":{"remainingFraction":0.77,"resetTime":"2030-01-02T00:00:00Z"}}
	}}`
	summary := `{"groups":[{"buckets":[
		{"bucketId":"gemini-weekly","remainingFraction":1.0,"resetTime":1893456000}
	]}]}`
	srv := cloudCodeMux(t, load, models, summary, nil)
	defer srv.Close()

	r := NewAntigravityRefresher(AntigravityEndpoints{CloudCodeBaseURL: srv.URL})
	a := &account.Account{AccessToken: "tok", ProjectID: "proj-1"}
	res, err := r.FetchQuota(a)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	bk := bucketKeys(res)
	g5, ok := bk["gemini-5h"]
	if !ok {
		t.Fatalf("gemini-5h should be filled from per-model fallback, buckets=%+v", res.Buckets)
	}
	if g5.Percent != 33 {
		t.Fatalf("gemini-5h fallback pct=%d want 33", g5.Percent)
	}
	if bk["gemini-weekly"].Percent != 100 {
		t.Fatalf("gemini-weekly pct=%d want 100", bk["gemini-weekly"].Percent)
	}
}

// TestAntigravityRefresher_FetchQuota_OnboardsWhenNoProject:个人号无 project,
// loadCodeAssist 不带 project 但给 allowedTiers → onboardUser 领到 project 并回填 acc.ProjectID。
func TestAntigravityRefresher_FetchQuota_OnboardsWhenNoProject(t *testing.T) {
	load := `{"allowedTiers":[{"id":"free-tier","isDefault":true}],"currentTier":{"id":"free-tier"}}`
	models := `{"models":{}}`
	summary := `{"groups":[{"buckets":[
		{"bucketId":"gemini-5h","remainingFraction":1.0,"resetTime":"2030-01-01T00:00:00Z"}
	]}]}`
	onboard := func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"done":true,"response":{"cloudaicompanionProject":{"id":"onboarded-proj"}}}`))
	}
	srv := cloudCodeMux(t, load, models, summary, onboard)
	defer srv.Close()

	r := NewAntigravityRefresher(AntigravityEndpoints{CloudCodeBaseURL: srv.URL})
	a := &account.Account{AccessToken: "tok"} // 无 ProjectID
	res, err := r.FetchQuota(a)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	if a.ProjectID != "onboarded-proj" {
		t.Fatalf("ProjectID not backfilled, got %q", a.ProjectID)
	}
	if bucketKeys(res)["gemini-5h"].Percent != 100 {
		t.Fatalf("gemini-5h pct wrong: %+v", res.Buckets)
	}
}

// TestAntigravityRefresher_FetchQuota_NoProject:loadCodeAssist 无 project 且无 tier 可 onboard →
// 拿不到 project,直接报错(surfaced 给用户,而非静默无反应)。
func TestAntigravityRefresher_FetchQuota_NoProject(t *testing.T) {
	srv := cloudCodeMux(t, `{}`, `{"models":{}}`, `{}`, nil)
	defer srv.Close()

	r := NewAntigravityRefresher(AntigravityEndpoints{CloudCodeBaseURL: srv.URL})
	_, err := r.FetchQuota(&account.Account{AccessToken: "tok"})
	if err == nil {
		t.Fatal("expected error when project cannot be determined")
	}
}

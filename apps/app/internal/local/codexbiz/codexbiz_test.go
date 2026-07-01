package codexbiz

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// jwtAccessToken 构造一个未签名 JWT,payload 内含 chatgpt_account_id。
// codex 不验签(见 memory codex-takeover-auth),仅解 payload。
func jwtAccessToken(accountID string) string {
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	body, _ := json.Marshal(map[string]any{
		"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": accountID},
	})
	pl := base64.RawURLEncoding.EncodeToString(body)
	return hdr + "." + pl + ".sig"
}

// doerFunc 是 httpDoer 的函数式 mock。
type doerFunc func(*http.Request) (*http.Response, error)

func (f doerFunc) Do(req *http.Request) (*http.Response, error) { return f(req) }

// jsonResp 构造一个 JSON 响应。
func jsonResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func newTestClient(d doerFunc) *Client {
	return NewClient(Options{Doer: d})
}

// ── 订阅 RefreshSubscription ──

func TestRefreshSubscription_AccountCheckOnly(t *testing.T) {
	var gotAuth, gotAccID, gotTargetPath string
	var gotURL string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		gotAuth = req.Header.Get("Authorization")
		gotAccID = req.Header.Get("ChatGPT-Account-Id")
		gotTargetPath = req.Header.Get("x-openai-target-path")
		// accounts/check 返回一个未过期订阅,因此不应再打 subscriptions。
		return jsonResp(200, `{
			"accounts": {
				"acc-1": {
					"account": {"account_id": "acc-1"},
					"entitlement": {"subscription_plan": "chatgpt_plus", "expires_at": "4102444800"}
				}
			}
		}`), nil
	})

	snap, err := c.RefreshSubscription(Account{AccessToken: "tok-abc", AccountID: "acc-1"})
	if err != nil {
		t.Fatalf("RefreshSubscription error: %v", err)
	}
	if !strings.Contains(gotURL, "/backend-api/accounts/check/v4-2023-04-27") {
		t.Errorf("expected accounts/check url, got %q", gotURL)
	}
	if !strings.Contains(gotURL, "timezone_offset_min=") {
		t.Errorf("expected timezone_offset_min query, got %q", gotURL)
	}
	if gotAuth != "Bearer tok-abc" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotTargetPath != "/backend-api/accounts/check/v4-2023-04-27" {
		t.Errorf("x-openai-target-path = %q", gotTargetPath)
	}
	_ = gotAccID
	if snap.PlanType != "chatgpt_plus" {
		t.Errorf("PlanType = %q, want chatgpt_plus", snap.PlanType)
	}
	if snap.SubscriptionActiveUntil != "4102444800" {
		t.Errorf("SubscriptionActiveUntil = %q", snap.SubscriptionActiveUntil)
	}
	if snap.AccountID != "acc-1" {
		t.Errorf("AccountID = %q", snap.AccountID)
	}
}

func TestRefreshSubscription_FallsBackToSubscriptions(t *testing.T) {
	var calls []string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		calls = append(calls, req.URL.Path)
		if strings.Contains(req.URL.Path, "accounts/check") {
			// 过期订阅 -> 触发 subscriptions 回退。
			return jsonResp(200, `{
				"accounts": {"acc-9": {"account": {"account_id": "acc-9"},
					"entitlement": {"subscription_plan": "free", "expires_at": "1000000000"}}}
			}`), nil
		}
		// subscriptions 端点
		if got := req.URL.Query().Get("account_id"); got != "acc-9" {
			t.Errorf("subscriptions account_id = %q, want acc-9", got)
		}
		return jsonResp(200, `{"subscription_plan": "chatgpt_pro", "active_until": "4102444800"}`), nil
	})

	snap, err := c.RefreshSubscription(Account{AccessToken: "t", AccountID: "acc-9"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("expected 2 upstream calls, got %d: %v", len(calls), calls)
	}
	if snap.PlanType != "chatgpt_pro" || snap.SubscriptionActiveUntil != "4102444800" {
		t.Errorf("snapshot not merged from subscriptions: %+v", snap)
	}
}

func TestRefreshSubscription_HTTPError(t *testing.T) {
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResp(403, `{"detail": {"code": "forbidden"}}`), nil
	})
	_, err := c.RefreshSubscription(Account{AccessToken: "t", AccountID: "a"})
	if err == nil {
		t.Fatal("expected error on 403")
	}
	if !strings.Contains(err.Error(), "forbidden") {
		t.Errorf("error should carry detail code, got %v", err)
	}
}

// ── reset 次数 GetResetCredits / ConsumeResetCredit ──

func TestGetResetCredits_ParsesSnapshot(t *testing.T) {
	var gotURL, gotBeta, gotOriginator string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		gotBeta = req.Header.Get("OpenAI-Beta")
		gotOriginator = req.Header.Get("originator")
		return jsonResp(200, `{
			"available_count": 2,
			"credits": [
				{"id": "c1", "status": "available", "expires_at": 4102444800},
				{"id": "c2", "status": "redeemed", "expires_at": 4102444800}
			]
		}`), nil
	})

	snap, err := c.GetResetCredits(Account{AccessToken: "t", AccountID: "a"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(gotURL, "/backend-api/wham/rate-limit-reset-credits") {
		t.Errorf("url = %q", gotURL)
	}
	if gotBeta != "codex-1" {
		t.Errorf("OpenAI-Beta = %q, want codex-1", gotBeta)
	}
	if gotOriginator != "Codex Desktop" {
		t.Errorf("originator = %q", gotOriginator)
	}
	if snap.AvailableCount == nil || *snap.AvailableCount != 2 {
		t.Errorf("AvailableCount = %v, want 2", snap.AvailableCount)
	}
	if len(snap.Credits) != 2 {
		t.Errorf("len(Credits) = %d, want 2", len(snap.Credits))
	}
	if snap.NextExpiresAt == nil || *snap.NextExpiresAt != 4102444800 {
		t.Errorf("NextExpiresAt = %v", snap.NextExpiresAt)
	}
}

func TestGetResetCredits_DerivesAvailableCount(t *testing.T) {
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		// 缺 available_count -> 从 credits 推导(只数可用的)。
		return jsonResp(200, `{
			"credits": [
				{"id": "c1", "status": "available", "expires_at": 4102444800},
				{"id": "c2", "status": "used", "expires_at": 4102444800}
			]
		}`), nil
	})
	snap, err := c.GetResetCredits(Account{AccessToken: "t", AccountID: "a"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if snap.AvailableCount == nil || *snap.AvailableCount != 1 {
		t.Errorf("derived AvailableCount = %v, want 1", snap.AvailableCount)
	}
}

func TestConsumeResetCredit_PostsRedeemRequestID(t *testing.T) {
	var gotURL, gotMethod, gotCT string
	var bodyRedeem string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		gotMethod = req.Method
		gotCT = req.Header.Get("Content-Type")
		raw, _ := io.ReadAll(req.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		bodyRedeem, _ = m["redeem_request_id"].(string)
		return jsonResp(200, `{}`), nil
	})

	err := c.ConsumeResetCredit(Account{AccessToken: "t", AccountID: "a"}, "req-123")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q", gotMethod)
	}
	if !strings.Contains(gotURL, "/backend-api/wham/rate-limit-reset-credits/consume") {
		t.Errorf("url = %q", gotURL)
	}
	if gotCT != "application/json" {
		t.Errorf("Content-Type = %q", gotCT)
	}
	if bodyRedeem != "req-123" {
		t.Errorf("redeem_request_id = %q, want req-123", bodyRedeem)
	}
}

func TestConsumeResetCredit_GeneratesRedeemIDWhenEmpty(t *testing.T) {
	var bodyRedeem string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		bodyRedeem, _ = m["redeem_request_id"].(string)
		return jsonResp(200, `{}`), nil
	})
	if err := c.ConsumeResetCredit(Account{AccessToken: "t", AccountID: "a"}, ""); err != nil {
		t.Fatalf("err: %v", err)
	}
	if bodyRedeem == "" {
		t.Error("expected a generated redeem_request_id when caller passes empty")
	}
}

func TestConsumeResetCredit_HTTPError(t *testing.T) {
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResp(429, `{"detail": {"code": "rate_limited"}}`), nil
	})
	err := c.ConsumeResetCredit(Account{AccessToken: "t", AccountID: "a"}, "x")
	if err == nil {
		t.Fatal("expected error on 429")
	}
	if !strings.Contains(err.Error(), "rate_limited") {
		t.Errorf("error should carry detail code, got %v", err)
	}
}

// ── 邀请返利 ReferralEligibility / ReferralRules / SendReferralInvites ──

func TestReferralEligibility_ParsesAndUsesDefaultKey(t *testing.T) {
	var gotKey, gotURL string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		gotKey = req.URL.Query().Get("referral_key")
		return jsonResp(200, `{
			"should_show": true,
			"remaining_referrals": 4,
			"grant_action": "credit",
			"grant_amount": 500
		}`), nil
	})

	elig, err := c.ReferralEligibility(Account{AccessToken: "t", AccountID: "a"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(gotURL, "/backend-api/referrals/invite/eligibility") {
		t.Errorf("url = %q", gotURL)
	}
	if gotKey != DefaultReferralKey {
		t.Errorf("referral_key = %q, want default %q", gotKey, DefaultReferralKey)
	}
	if !elig.ShouldShow {
		t.Error("ShouldShow should be true")
	}
	if elig.RemainingReferrals == nil || *elig.RemainingReferrals != 4 {
		t.Errorf("RemainingReferrals = %v", elig.RemainingReferrals)
	}
	if elig.ReferralKey != DefaultReferralKey {
		t.Errorf("ReferralKey echoed = %q", elig.ReferralKey)
	}
}

func TestReferralRules_ParsesTimeFrameRules(t *testing.T) {
	var gotURL string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		return jsonResp(200, `{
			"requires_explicit_confirmation": true,
			"rules": ["rule_a", "  ", "rule_b"],
			"time_frame_rules": [{"type": "weekly", "invites_sent": 2, "invites_total": 5}]
		}`), nil
	})

	rules, err := c.ReferralRules(Account{AccessToken: "t", AccountID: "a"}, "custom-key")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(gotURL, "/backend-api/wham/referrals/eligibility_rules") {
		t.Errorf("url = %q", gotURL)
	}
	if rules.RequiresExplicitConfirmation == nil || !*rules.RequiresExplicitConfirmation {
		t.Errorf("RequiresExplicitConfirmation = %v", rules.RequiresExplicitConfirmation)
	}
	if len(rules.Rules) != 2 {
		t.Errorf("Rules = %v, want 2 non-empty", rules.Rules)
	}
	if len(rules.TimeFrameRules) != 1 || rules.TimeFrameRules[0].RuleType != "weekly" {
		t.Errorf("TimeFrameRules = %+v", rules.TimeFrameRules)
	}
	if rules.TimeFrameRules[0].InvitesSent != 2 || rules.TimeFrameRules[0].InvitesTotal != 5 {
		t.Errorf("time frame counts = %+v", rules.TimeFrameRules[0])
	}
}

func TestSendReferralInvites_PostsEmails(t *testing.T) {
	var gotMethod, gotURL string
	var sentEmails []any
	var sentKey string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotMethod = req.Method
		gotURL = req.URL.String()
		raw, _ := io.ReadAll(req.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		sentEmails, _ = m["emails"].([]any)
		sentKey, _ = m["referral_key"].(string)
		return jsonResp(200, `{"invites": [{"email": "a@x.com"}, {"email": "b@x.com"}]}`), nil
	})

	resp, err := c.SendReferralInvites(Account{AccessToken: "t", AccountID: "a"}, "", []string{" a@x.com ", "b@x.com", ""})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q", gotMethod)
	}
	if !strings.Contains(gotURL, "/backend-api/wham/referrals/invite") {
		t.Errorf("url = %q", gotURL)
	}
	if sentKey != DefaultReferralKey {
		t.Errorf("referral_key = %q", sentKey)
	}
	// 空白被 trim,空串被丢弃 -> 2 个邮箱。
	if len(sentEmails) != 2 {
		t.Errorf("sent emails = %v, want 2 cleaned", sentEmails)
	}
	if len(resp.Invites) != 2 {
		t.Errorf("parsed invites = %d, want 2", len(resp.Invites))
	}
}

func TestSendReferralInvites_RejectsEmptyAndTooMany(t *testing.T) {
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		t.Fatal("should not hit upstream for invalid input")
		return nil, nil
	})
	if _, err := c.SendReferralInvites(Account{AccessToken: "t"}, "", []string{"", "  "}); err == nil {
		t.Error("expected error for empty emails")
	}
	if _, err := c.SendReferralInvites(Account{AccessToken: "t"}, "", []string{"1@x", "2@x", "3@x", "4@x", "5@x", "6@x"}); err == nil {
		t.Error("expected error for >5 emails")
	}
}

func TestSendReferralInvites_HTTPErrorCarriesDetail(t *testing.T) {
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResp(400, `{"detail": {"message": "bad", "failed_emails": ["x@y.com"]}}`), nil
	})
	_, err := c.SendReferralInvites(Account{AccessToken: "t"}, "", []string{"x@y.com"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "bad") || !strings.Contains(err.Error(), "x@y.com") {
		t.Errorf("error should include message and failed_emails, got %v", err)
	}
}

// ChatGPT-Account-Id 在缺显式 AccountID 时应从 access_token JWT 提取。
func TestAccountIDFallbackFromJWT(t *testing.T) {
	var gotAccID string
	c := newTestClient(func(req *http.Request) (*http.Response, error) {
		gotAccID = req.Header.Get("ChatGPT-Account-Id")
		return jsonResp(200, `{"credits": []}`), nil
	})
	tok := jwtAccessToken("acc-from-jwt")
	if _, err := c.GetResetCredits(Account{AccessToken: tok}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if gotAccID != "acc-from-jwt" {
		t.Errorf("ChatGPT-Account-Id = %q, want acc-from-jwt", gotAccID)
	}
}

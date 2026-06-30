package quota

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

// jwtWith 构造一个未签名(签名段任意)的 JWT,payload 含给定 claims。
// codex 不验签(见 memory codex-takeover-auth),只解 payload。
func jwtWith(t *testing.T, claims map[string]any) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	body, _ := json.Marshal(claims)
	pl := base64.RawURLEncoding.EncodeToString(body)
	return hdr + "." + pl + ".sig"
}

// codexAccessToken 构造带 chatgpt_account_id 与 exp 的 access_token。
func codexAccessToken(t *testing.T, accountID string, exp int64) string {
	return jwtWith(t, map[string]any{
		"exp": exp,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": accountID,
		},
	})
}

func TestExtractChatGPTAccountID(t *testing.T) {
	tok := codexAccessToken(t, "acc-123", time.Now().Add(time.Hour).Unix())
	if got := extractChatGPTAccountID(tok); got != "acc-123" {
		t.Fatalf("extractChatGPTAccountID = %q, want acc-123", got)
	}
	if got := extractChatGPTAccountID("not-a-jwt"); got != "" {
		t.Fatalf("non-jwt should yield empty, got %q", got)
	}
}

func TestIsJWTExpired(t *testing.T) {
	past := jwtWith(t, map[string]any{"exp": time.Now().Add(-time.Hour).Unix()})
	future := jwtWith(t, map[string]any{"exp": time.Now().Add(time.Hour).Unix()})
	if !isJWTExpired(past) {
		t.Fatal("past token should be expired")
	}
	if isJWTExpired(future) {
		t.Fatal("future token should not be expired")
	}
}

// TestCodexFetchQuota_ParsesWindows 校验照搬 cockpit 的 wham/usage 解析:
// used_percent -> remaining = 100-used, reset_at / reset_after_seconds。
func TestCodexFetchQuota_ParsesWindows(t *testing.T) {
	resetAt := time.Now().Add(2 * time.Hour).Unix()
	var gotAuth, gotAccID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccID = r.Header.Get("ChatGPT-Account-Id")
		if !strings.HasSuffix(r.URL.Path, "/backend-api/wham/usage") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{
				"primary_window":   map[string]any{"used_percent": 30, "reset_at": resetAt},
				"secondary_window": map[string]any{"used_percent": 80, "reset_after_seconds": 3600},
			},
		})
	}))
	defer srv.Close()

	c := NewCodexFetcher(CodexEndpoints{UsageURL: srv.URL + "/backend-api/wham/usage"})
	acc := &account.Account{
		AuthKind:    account.AuthOAuth,
		AccessToken: codexAccessToken(t, "acc-xyz", time.Now().Add(time.Hour).Unix()),
	}
	res, err := c.FetchQuota(acc)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	if res.HourlyPercent != 70 {
		t.Fatalf("HourlyPercent = %d, want 70", res.HourlyPercent)
	}
	if res.WeeklyPercent != 20 {
		t.Fatalf("WeeklyPercent = %d, want 20", res.WeeklyPercent)
	}
	if res.HourlyResetAt != resetAt*1000 {
		t.Fatalf("HourlyResetAt = %d, want %d (ms)", res.HourlyResetAt, resetAt*1000)
	}
	if res.WeeklyResetAt <= time.Now().UnixMilli() {
		t.Fatalf("WeeklyResetAt should be in the future, got %d", res.WeeklyResetAt)
	}
	if res.PlanType != "pro" {
		t.Fatalf("PlanType = %q, want pro", res.PlanType)
	}
	if gotAuth == "" || gotAccID != "acc-xyz" {
		t.Fatalf("headers wrong: auth=%q accId=%q", gotAuth, gotAccID)
	}
}

// TestCodexFetchQuota_MissingWindowsFull:缺窗口=满血(100,reset 0)。
func TestCodexFetchQuota_MissingWindowsFull(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"plan_type": "free", "rate_limit": map[string]any{}})
	}))
	defer srv.Close()
	c := NewCodexFetcher(CodexEndpoints{UsageURL: srv.URL + "/u"})
	acc := &account.Account{AuthKind: account.AuthOAuth, AccessToken: codexAccessToken(t, "a", time.Now().Add(time.Hour).Unix())}
	res, err := c.FetchQuota(acc)
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	if res.HourlyPercent != 100 || res.WeeklyPercent != 100 {
		t.Fatalf("missing windows should be 100/100, got %d/%d", res.HourlyPercent, res.WeeklyPercent)
	}
}

// TestCodexFetchQuota_HTTPErrorReturnsErr:非 2xx -> error。
func TestCodexFetchQuota_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"detail":{"code":"token_expired"}}`))
	}))
	defer srv.Close()
	c := NewCodexFetcher(CodexEndpoints{UsageURL: srv.URL + "/u"})
	acc := &account.Account{AuthKind: account.AuthOAuth, AccessToken: codexAccessToken(t, "a", time.Now().Add(time.Hour).Unix())}
	if _, err := c.FetchQuota(acc); err == nil {
		t.Fatal("expected error on 401")
	}
}

// TestCodexRefreshToken 校验照搬 cockpit 的 oauth/token 刷新:grant_type=refresh_token。
func TestCodexRefreshToken(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id_token":      "new-id",
			"access_token":  "new-access",
			"refresh_token": "new-refresh",
		})
	}))
	defer srv.Close()
	c := NewCodexFetcher(CodexEndpoints{TokenURL: srv.URL + "/token"})
	tok, err := c.RefreshToken("old-refresh", "old-id")
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if tok.AccessToken != "new-access" || tok.RefreshToken != "new-refresh" || tok.IDToken != "new-id" {
		t.Fatalf("token wrong: %+v", tok)
	}
	if gotBody["grant_type"] != "refresh_token" || gotBody["refresh_token"] != "old-refresh" {
		t.Fatalf("request body wrong: %+v", gotBody)
	}
}

// TestCodexRefreshToken_KeepsOldRefreshAndID:响应缺 refresh_token/id_token 时复用旧值。
func TestCodexRefreshToken_KeepsOld(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access"})
	}))
	defer srv.Close()
	c := NewCodexFetcher(CodexEndpoints{TokenURL: srv.URL + "/token"})
	tok, err := c.RefreshToken("keep-refresh", "keep-id")
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if tok.RefreshToken != "keep-refresh" || tok.IDToken != "keep-id" {
		t.Fatalf("should keep old refresh/id: %+v", tok)
	}
}

// TestAntigravityRefreshToken 校验 Google oauth token 刷新。
func TestAntigravityRefreshToken(t *testing.T) {
	var form string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.Form.Encode()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "ag-access",
			"expires_in":   3600,
		})
	}))
	defer srv.Close()
	c := NewAntigravityFetcher(AntigravityEndpoints{TokenURL: srv.URL + "/token"})
	tok, err := c.RefreshToken("ag-refresh")
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if tok.AccessToken != "ag-access" {
		t.Fatalf("access wrong: %+v", tok)
	}
	if tok.Expiry <= time.Now().Unix() {
		t.Fatalf("expiry should be in the future, got %d", tok.Expiry)
	}
	if !strings.Contains(form, "grant_type=refresh_token") || !strings.Contains(form, "refresh_token=ag-refresh") {
		t.Fatalf("form wrong: %s", form)
	}
}

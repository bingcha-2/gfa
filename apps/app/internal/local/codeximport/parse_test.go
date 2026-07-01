package codeximport

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"bcai-wails/internal/local/account"
)

// fakeJWT 造一个 payload-only JWT(codex 不验签名,只解 payload),便于测 email/exp 提取。
func fakeJWT(claims map[string]any) string {
	body, _ := json.Marshal(claims)
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload := base64.RawURLEncoding.EncodeToString(body)
	return header + "." + payload + ".sig"
}

func TestParseAuthJSON_Flat(t *testing.T) {
	raw := []byte(`{"id_token":"id.jwt","access_token":"acc.jwt","refresh_token":"rt_123","account_id":"acc_1","email":"demo@example.com"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.Provider != account.ProviderCodex || a.AuthKind != account.AuthOAuth {
		t.Fatalf("provider/kind wrong: %+v", a)
	}
	if a.IDToken != "id.jwt" || a.AccessToken != "acc.jwt" || a.RefreshToken != "rt_123" || a.AccountID != "acc_1" {
		t.Fatalf("tokens wrong: %+v", a)
	}
	if a.Email != "demo@example.com" {
		t.Fatalf("email wrong: %q", a.Email)
	}
	if !a.PoolEnabled || a.QuotaStatus != account.QuotaOK {
		t.Fatalf("defaults wrong: %+v", a)
	}
}

func TestParseAuthJSON_NestedTokens(t *testing.T) {
	raw := []byte(`{"tokens":{"id_token":"id.jwt","access_token":"acc.jwt","refresh_token":"rt_456","account_id":"acc_2"}}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.AccessToken != "acc.jwt" || a.RefreshToken != "rt_456" || a.AccountID != "acc_2" {
		t.Fatalf("nested wrong: %+v", a)
	}
}

func TestParseAuthJSON_CamelCase(t *testing.T) {
	raw := []byte(`{"tokens":{"idToken":"id.jwt","accessToken":"acc.jwt","refreshToken":"rt_789"},"accountId":"acc_3"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.AccessToken != "acc.jwt" || a.RefreshToken != "rt_789" || a.AccountID != "acc_3" {
		t.Fatalf("camel wrong: %+v", a)
	}
}

func TestParseAuthJSON_APIKey(t *testing.T) {
	raw := []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-abc"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.AuthKind != account.AuthAPIKey || a.APIKey != "sk-abc" {
		t.Fatalf("apikey wrong: %+v", a)
	}
}

func TestParseAuthJSON_EmailFromIDToken(t *testing.T) {
	// 顶层无 email,但 id_token 含 email claim。
	idTok := fakeJWT(map[string]any{"email": "jwt@example.com"})
	raw := []byte(`{"access_token":"acc.jwt","id_token":"` + idTok + `","refresh_token":"rt"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.Email != "jwt@example.com" {
		t.Fatalf("email-from-idtoken wrong: %q", a.Email)
	}
}

func TestParseAuthJSON_EmailFromAccessTokenProfile(t *testing.T) {
	// email 藏在 access_token 的 https://api.openai.com/profile.email。
	accTok := fakeJWT(map[string]any{"https://api.openai.com/profile": map[string]any{"email": "prof@example.com"}})
	raw := []byte(`{"access_token":"` + accTok + `","refresh_token":"rt"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.Email != "prof@example.com" {
		t.Fatalf("email-from-profile wrong: %q", a.Email)
	}
}

func TestParseAuthJSON_AccountIDFromAccessToken(t *testing.T) {
	// 无显式 account_id,从 access_token 的 chatgpt_account_id 提取。
	accTok := fakeJWT(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "cid_9"}})
	raw := []byte(`{"access_token":"` + accTok + `","refresh_token":"rt","email":"x@y.com"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.AccountID != "cid_9" {
		t.Fatalf("account-id-from-access wrong: %q", a.AccountID)
	}
}

func TestParseAuthJSON_Invalid(t *testing.T) {
	if _, err := ParseAuthJSON([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid json")
	}
	// 既无 token 又无 api key:无法构造账号。
	if _, err := ParseAuthJSON([]byte(`{"foo":"bar"}`)); err == nil {
		t.Fatal("expected error for empty auth")
	}
}

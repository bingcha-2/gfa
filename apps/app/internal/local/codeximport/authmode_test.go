package codeximport

import (
	"testing"

	"bcai-wails/internal/local/account"
)

// 回归:带 OPENAI_API_KEY 的 OAuth auth.json 必须按 OAuth 导入(不能因为有 key 就当 API-Key 号、丢 token)。
func TestParseAuthJSON_OAuthWithStrayAPIKey(t *testing.T) {
	raw := []byte(`{"OPENAI_API_KEY":"sk-stray","tokens":{"id_token":"id","access_token":"AT","refresh_token":"RT","account_id":"acc"}}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatalf("ParseAuthJSON: %v", err)
	}
	if a.AuthKind != account.AuthOAuth {
		t.Fatalf("应按 OAuth 导入,得到 %s", a.AuthKind)
	}
	if a.AccessToken != "AT" || a.RefreshToken != "RT" {
		t.Fatalf("OAuth token 丢了: %+v", a)
	}
}

// auth_mode=apikey 才走 API-Key 形态。
func TestParseAuthJSON_ApiKeyMode(t *testing.T) {
	raw := []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-real"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatalf("ParseAuthJSON: %v", err)
	}
	if a.AuthKind != account.AuthAPIKey || a.APIKey != "sk-real" {
		t.Fatalf("应按 API-Key 导入,得到 %+v", a)
	}
}

// 只有 key、无任何 token、无 auth_mode → 回退当 API-Key 号。
func TestParseAuthJSON_KeyOnlyFallbackApiKey(t *testing.T) {
	raw := []byte(`{"OPENAI_API_KEY":"sk-only"}`)
	a, err := ParseAuthJSON(raw)
	if err != nil {
		t.Fatalf("ParseAuthJSON: %v", err)
	}
	if a.AuthKind != account.AuthAPIKey {
		t.Fatalf("无 token 时应回退 API-Key,得到 %s", a.AuthKind)
	}
}

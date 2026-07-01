package codexauth

import (
	"testing"

	"bcai-wails/internal/local/account"
)

func TestDecodeTokens(t *testing.T) {
	toks := decodeTokens(map[string]any{
		"id_token": "i", "access_token": "a", "refresh_token": "r",
		"account_id": "acc", "email": "e@x.com",
	})
	if toks.AccessToken != "a" || toks.RefreshToken != "r" || toks.IDToken != "i" || toks.AccountID != "acc" || toks.Email != "e@x.com" {
		t.Fatalf("decode wrong: %+v", toks)
	}
}

func TestDecodeTokens_Nil(t *testing.T) {
	if got := decodeTokens(nil); got.AccessToken != "" {
		t.Fatalf("nil storage should be empty: %+v", got)
	}
}

func TestBuildAccount(t *testing.T) {
	a := buildAccount(codexTokens{AccessToken: "a", RefreshToken: "r", Email: "e@x.com"}, "pro", "")
	if a.Provider != account.ProviderCodex || a.AuthKind != account.AuthOAuth || a.PlanType != "pro" || !a.PoolEnabled || a.Email != "e@x.com" {
		t.Fatalf("build wrong: %+v", a)
	}
	if a.QuotaStatus != account.QuotaOK {
		t.Fatalf("expected QuotaOK, got %q", a.QuotaStatus)
	}
}

func TestBuildAccount_MetaEmailFallback(t *testing.T) {
	a := buildAccount(codexTokens{AccessToken: "a"}, "plus", "fallback@x.com")
	if a.Email != "fallback@x.com" {
		t.Fatalf("expected meta email fallback, got %q", a.Email)
	}
}

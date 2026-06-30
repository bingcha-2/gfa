package antigravityauth

import (
	"testing"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestAuthToAccount_FromMetadata(t *testing.T) {
	a := &coreauth.Auth{
		Provider: "antigravity",
		Label:    "user@example.com",
		Metadata: map[string]any{
			"email":         "user@example.com",
			"access_token":  "at",
			"refresh_token": "rt",
			"project_id":    "gcp-1",
			"account_id":    "acc",
		},
		Attributes: map[string]string{"plan_type": "pro"},
	}
	got := authToAccount(a)
	if got.Provider != account.ProviderAntigravity || got.Email != "user@example.com" || got.AccessToken != "at" ||
		got.RefreshToken != "rt" || got.ProjectID != "gcp-1" || got.AccountID != "acc" || got.PlanType != "pro" ||
		!got.PoolEnabled || got.AuthKind != account.AuthOAuth || got.QuotaStatus != account.QuotaOK {
		t.Fatalf("mapping wrong: %+v", got)
	}
}

func TestAuthToAccount_EmailFallbackToLabel(t *testing.T) {
	a := &coreauth.Auth{Provider: "antigravity", Label: "fallback@x.com", Metadata: map[string]any{"access_token": "at"}}
	if got := authToAccount(a); got.Email != "fallback@x.com" {
		t.Fatalf("expected label fallback, got %q", got.Email)
	}
}

func TestAuthToAccount_ExpiryFromRFC3339(t *testing.T) {
	a := &coreauth.Auth{Provider: "antigravity", Metadata: map[string]any{
		"access_token": "at",
		"expired":      "2030-01-01T00:00:00Z",
	}}
	if got := authToAccount(a); got.Expiry != 1893456000 {
		t.Fatalf("expected expiry 1893456000 from RFC3339, got %d", got.Expiry)
	}
}

func TestAuthToAccount_ExpiryFallbackTimestampPlusExpiresIn(t *testing.T) {
	// 无 "expired",回退 timestamp(unix ms)+ expires_in(秒)。
	a := &coreauth.Auth{Provider: "antigravity", Metadata: map[string]any{
		"access_token": "at",
		"timestamp":    int64(1_700_000_000_000), // ms
		"expires_in":   3600,
	}}
	if got := authToAccount(a); got.Expiry != 1_700_000_000+3600 {
		t.Fatalf("expected fallback expiry %d, got %d", 1_700_000_000+3600, got.Expiry)
	}
}

func TestAuthToAccount_ExpiryUnknownIsZero(t *testing.T) {
	a := &coreauth.Auth{Provider: "antigravity", Metadata: map[string]any{"access_token": "at"}}
	if got := authToAccount(a); got.Expiry != 0 {
		t.Fatalf("expected 0 when no expiry metadata, got %d", got.Expiry)
	}
}

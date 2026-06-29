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

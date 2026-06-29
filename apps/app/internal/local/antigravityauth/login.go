// Package antigravityauth 封装 CLIProxyAPI 的 Antigravity(Google)OAuth 登录,
// 产出本地自有号。与 codexauth 对应;antigravity 的 token 全在 Auth.Metadata。
package antigravityauth

import (
	"context"

	"bcai-wails/internal/local/account"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// Login 走完整 Google OAuth(SDK 开浏览器+本地回调),成功后映射为本地自有号。
func Login(ctx context.Context, cfg *config.Config) (*account.Account, error) {
	if cfg == nil {
		cfg = &config.Config{}
	}
	auth, err := sdkauth.NewAntigravityAuthenticator().Login(ctx, cfg, &sdkauth.LoginOptions{})
	if err != nil {
		return nil, err
	}
	return authToAccount(auth), nil
}

func metaStr(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	s, _ := m[k].(string)
	return s
}

func authToAccount(a *coreauth.Auth) *account.Account {
	email := metaStr(a.Metadata, "email")
	if email == "" {
		email = a.Label
	}
	return &account.Account{
		Provider:     account.ProviderAntigravity,
		Email:        email,
		AuthKind:     account.AuthOAuth,
		AccessToken:  metaStr(a.Metadata, "access_token"),
		RefreshToken: metaStr(a.Metadata, "refresh_token"),
		AccountID:    metaStr(a.Metadata, "account_id"),
		ProjectID:    metaStr(a.Metadata, "project_id"),
		PlanType:     a.Attributes["plan_type"],
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}
}

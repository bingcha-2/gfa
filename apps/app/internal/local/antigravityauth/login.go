// Package antigravityauth 封装 CLIProxyAPI 的 Antigravity(Google)OAuth 登录,
// 产出本地自有号。与 codexauth 对应;antigravity 的 token 全在 Auth.Metadata。
package antigravityauth

import (
	"context"
	"time"

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

func metaInt64(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	default:
		return 0
	}
}

// metaExpiry 从 SDK Auth.Metadata 取 access_token 过期时刻(unix 秒)。
// SDK(sdk/auth/antigravity.go)写入 "expired"(RFC3339)+ "timestamp"(unix ms)+
// "expires_in"(秒);优先解析 RFC3339,回退到 timestamp+expires_in。0=未知。
func metaExpiry(m map[string]any) int64 {
	if m == nil {
		return 0
	}
	if s := metaStr(m, "expired"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.Unix()
		}
	}
	if ts, ei := metaInt64(m, "timestamp"), metaInt64(m, "expires_in"); ts > 0 && ei > 0 {
		return ts/1000 + ei
	}
	return 0
}

func authToAccount(a *coreauth.Auth) *account.Account {
	email := metaStr(a.Metadata, "email")
	if email == "" {
		email = a.Label
	}
	// IsGCPTos:SDK 不暴露此位,登录默认 false(注入侧对 gmail 亦恒置 false);
	// 字段已贯通,后续若能从上游/用户确认再回填。
	return &account.Account{
		Provider:     account.ProviderAntigravity,
		Email:        email,
		AuthKind:     account.AuthOAuth,
		AccessToken:  metaStr(a.Metadata, "access_token"),
		RefreshToken: metaStr(a.Metadata, "refresh_token"),
		AccountID:    metaStr(a.Metadata, "account_id"),
		ProjectID:    metaStr(a.Metadata, "project_id"),
		Expiry:       metaExpiry(a.Metadata),
		PlanType:     a.Attributes["plan_type"],
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}
}

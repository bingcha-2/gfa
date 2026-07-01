// Package codexauth 封装 CLIProxyAPI 的 Codex OAuth 登录,产出本地自有号。
//
// SDK 的 CodexAuthenticator.Login 自带完整流程(起本地回调 server@1455、PKCE、
// 开浏览器、等回调、换 token),返回 *coreauth.Auth,其 token 藏在内部类型
// Storage 里。本包通过 JSON round-trip 提取 token(不 import 内部包),映射成
// account.Account。
package codexauth

import (
	"context"
	"encoding/json"

	"bcai-wails/internal/local/account"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// Login 走完整 OAuth(阻塞直至回调或 SDK 内 5 分钟超时),成功后映射为本地自有号。
func Login(ctx context.Context, cfg *config.Config) (*account.Account, error) {
	if cfg == nil {
		cfg = &config.Config{}
	}
	auth, err := sdkauth.NewCodexAuthenticator().Login(ctx, cfg, &sdkauth.LoginOptions{})
	if err != nil {
		return nil, err
	}
	return authToAccount(auth), nil
}

type codexTokens struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
	Email        string `json:"email"`
}

// decodeTokens 通过 JSON round-trip 从 SDK Storage(内部类型)提取 token。
func decodeTokens(storage any) codexTokens {
	var t codexTokens
	if storage == nil {
		return t
	}
	raw, err := json.Marshal(storage)
	if err != nil {
		return t
	}
	_ = json.Unmarshal(raw, &t)
	return t
}

func buildAccount(toks codexTokens, planType, metaEmail string) *account.Account {
	email := toks.Email
	if email == "" {
		email = metaEmail
	}
	return &account.Account{
		Provider:     account.ProviderCodex,
		Email:        email,
		AuthKind:     account.AuthOAuth,
		IDToken:      toks.IDToken,
		AccessToken:  toks.AccessToken,
		RefreshToken: toks.RefreshToken,
		AccountID:    toks.AccountID,
		PlanType:     planType,
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}
}

func authToAccount(a *coreauth.Auth) *account.Account {
	metaEmail, _ := a.Metadata["email"].(string)
	return buildAccount(decodeTokens(a.Storage), a.Attributes["plan_type"], metaEmail)
}

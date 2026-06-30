// Package codeximport 解析 codex 的 auth.json 形态(以及兼容变体),构造本地自有号。
//
// 这是 codexinject 写入的反向:codexinject 把账号写进 ~/.codex/auth.json;此处把
// 一份 auth.json(本机现成的 / 用户拖进来的文件)读回成 account.Account。
//
// 移植自 cockpit crates/cockpit-core/src/modules/codex_account.rs:
//   - extract_codex_tokens_from_value(flat / nested tokens / camelCase / session_token 回退)
//   - 从 id_token / access_token JWT 提取 email、chatgpt_account_id
package codeximport

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"bcai-wails/internal/local/account"
)

// ParseAuthJSON 把一份 codex auth.json(或其兼容变体)解析成本地自有号。
// 支持:apikey 形态(auth_mode=apikey + OPENAI_API_KEY)、OAuth 形态
// (flat / nested tokens / camelCase 键)。email/account_id 缺失时从 JWT 兜底提取。
func ParseAuthJSON(raw []byte) (*account.Account, error) {
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}

	// apikey 形态:auth_mode=apikey 或仅有 OPENAI_API_KEY 字符串。
	if key := apiKeyOf(v); key != "" {
		return &account.Account{
			Provider:    account.ProviderCodex,
			Email:       firstString(v, "email", "account_email"),
			AuthKind:    account.AuthAPIKey,
			APIKey:      key,
			PoolEnabled: true,
			QuotaStatus: account.QuotaOK,
		}, nil
	}

	idToken, accessToken, refreshToken, accountID := extractTokens(v)
	if accessToken == "" && refreshToken == "" {
		return nil, errors.New("codeximport: auth.json 既无 OPENAI_API_KEY 也无 access/refresh token")
	}

	email := firstString(v, "email", "account_email")
	if email == "" {
		email = emailFromJWT(idToken)
	}
	if email == "" {
		email = emailFromJWT(accessToken)
	}
	if accountID == "" {
		accountID = chatGPTAccountIDFromJWT(accessToken)
	}

	return &account.Account{
		Provider:     account.ProviderCodex,
		Email:        email,
		AuthKind:     account.AuthOAuth,
		IDToken:      idToken,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		AccountID:    accountID,
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}, nil
}

// apiKeyOf 取 apikey 形态的 OPENAI_API_KEY(string 才算;OAuth 形态此字段为 null)。
func apiKeyOf(v map[string]any) string {
	if s, ok := v["OPENAI_API_KEY"].(string); ok && strings.TrimSpace(s) != "" {
		return s
	}
	return firstString(v, "api_key", "apiKey")
}

// extractTokens 兼容 flat / nested "tokens" / camelCase 三种键布局,并对空
// refresh_token 回退到 session_token(对齐 cockpit extract_codex_tokens_from_value)。
func extractTokens(v map[string]any) (idToken, accessToken, refreshToken, accountID string) {
	src := v
	if nested, ok := v["tokens"].(map[string]any); ok {
		src = nested
	}
	idToken = firstString(src, "id_token", "idToken")
	accessToken = firstString(src, "access_token", "accessToken")
	refreshToken = firstString(src, "refresh_token", "refreshToken")
	if refreshToken == "" {
		refreshToken = firstString(v, "session_token", "sessionToken")
	}
	accountID = firstString(src, "account_id", "accountId")
	if accountID == "" {
		accountID = firstString(v, "account_id", "accountId")
	}
	return
}

func firstString(v map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := v[k].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// emailFromJWT 解 JWT payload 取 email(先顶层 email,再 https://api.openai.com/profile.email)。
func emailFromJWT(token string) string {
	p := decodeJWTPayload(token)
	if p == nil {
		return ""
	}
	if s, ok := p["email"].(string); ok && s != "" {
		return s
	}
	if prof, ok := p["https://api.openai.com/profile"].(map[string]any); ok {
		if s, ok := prof["email"].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// chatGPTAccountIDFromJWT 对齐 codex_account::extract_chatgpt_account_id_from_access_token。
func chatGPTAccountIDFromJWT(accessToken string) string {
	p := decodeJWTPayload(accessToken)
	if p == nil {
		return ""
	}
	auth, _ := p["https://api.openai.com/auth"].(map[string]any)
	if auth == nil {
		return ""
	}
	for _, k := range []string{"chatgpt_account_id", "account_id"} {
		if s, ok := auth[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		if rawPayload, err = base64.URLEncoding.DecodeString(parts[1]); err != nil {
			return nil
		}
	}
	var m map[string]any
	if json.Unmarshal(rawPayload, &m) != nil {
		return nil
	}
	return m
}

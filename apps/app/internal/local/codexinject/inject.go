// Package codexinject 把一份本地自有号写进 codex 的 ~/.codex/auth.json,
// 让真正的 codex CLI 以该号直连 OpenAI(注入式接管,对齐 cockpit
// codex_account.rs write_auth_file_to_dir / build_auth_file_value)。
//
// 这是「接管」——把号注入正版客户端,与「反代」(cliproxy 网关)是两回事。
package codexinject

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const apiKeyAuthMode = "apikey"

const authFileName = "auth.json"
const backupFileName = ".bcai-codex-auth-backup.json"

// Token 是注入 codex auth.json 所需的一份自有号登录态。
type Token struct {
	AuthKind     string // "oauth" | "apikey"
	IDToken      string
	AccessToken  string
	RefreshToken string
	AccountID    string
	APIKey       string
}

// authFile 对齐 cockpit ~/.codex/auth.json。OAuth:OPENAI_API_KEY=null + tokens + last_refresh;
// apikey:auth_mode="apikey" + OPENAI_API_KEY=string。
type authFile struct {
	AuthMode     string      `json:"auth_mode,omitempty"`
	OpenAIAPIKey any         `json:"OPENAI_API_KEY"`
	Tokens       *authTokens `json:"tokens,omitempty"`
	LastRefresh  string      `json:"last_refresh,omitempty"`
}

type authTokens struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	AccountID    string `json:"account_id"`
}

// InjectToHome 把一份 token 写进 codexHome/auth.json。首次注入时备份原文件,便于还原。
func InjectToHome(codexHome string, t Token) error {
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		return fmt.Errorf("创建 codex home 失败: %w", err)
	}
	authPath := filepath.Join(codexHome, authFileName)
	backupPath := filepath.Join(codexHome, backupFileName)

	// 首次注入:若已有 auth.json 且尚无备份,先备份(还原时恢复原登录态)。
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		if orig, rerr := os.ReadFile(authPath); rerr == nil {
			_ = os.WriteFile(backupPath, orig, 0o600)
		}
	}

	af, err := buildAuthFile(t)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(af, "", "  ")
	if err != nil {
		return fmt.Errorf("auth.json 序列化失败: %w", err)
	}
	if err := os.WriteFile(authPath, data, 0o600); err != nil {
		return fmt.Errorf("写入 auth.json 失败: %w", err)
	}
	return nil
}

func buildAuthFile(t Token) (authFile, error) {
	if t.AuthKind == apiKeyAuthMode || (t.APIKey != "" && t.AccessToken == "") {
		if t.APIKey == "" {
			return authFile{}, fmt.Errorf("API Key 账号缺少 OPENAI_API_KEY")
		}
		return authFile{AuthMode: apiKeyAuthMode, OpenAIAPIKey: t.APIKey}, nil
	}
	if t.AccessToken == "" {
		return authFile{}, fmt.Errorf("OAuth 账号缺少 access_token,无法写入 auth.json")
	}
	return authFile{
		OpenAIAPIKey: nil,
		Tokens: &authTokens{
			IDToken:      t.IDToken,
			AccessToken:  t.AccessToken,
			RefreshToken: t.RefreshToken,
			AccountID:    t.AccountID,
		},
		// codex 用 last_refresh 判 token 新鲜度;置当下,避免一启动就强刷。
		LastRefresh: time.Now().UTC().Format("2006-01-02T15:04:05.000000Z"),
	}, nil
}

// RestoreHome 还原注入前的 auth.json(有备份则恢复,否则删除注入文件)。
func RestoreHome(codexHome string) error {
	authPath := filepath.Join(codexHome, authFileName)
	backupPath := filepath.Join(codexHome, backupFileName)
	if orig, err := os.ReadFile(backupPath); err == nil {
		if werr := os.WriteFile(authPath, orig, 0o600); werr != nil {
			return fmt.Errorf("还原 auth.json 失败: %w", werr)
		}
		_ = os.Remove(backupPath)
		return nil
	}
	if err := os.Remove(authPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("移除 auth.json 失败: %w", err)
	}
	return nil
}

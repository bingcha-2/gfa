package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ─── OAuth2 Helpers + Login Flow ─────────────────────────────────────────
//
// 本文件包含 Google OAuth2 相关的辅助函数和完整的授权码登录流程：
// - normalizeOAuthProfile / resolveOAuthCreds
// - maskEmail
// - StartOAuthLogin（启动本地回调服务器 → 打开浏览器 → 交换 token）
// - fetchUserEmail

func normalizeOAuthProfile(profile string) string {
	p := strings.TrimSpace(strings.ToLower(profile))
	switch p {
	case "legacy", "legacy-cloud-code", "cloud-code", "cc":
		return "legacy"
	case "antigravity", "antigravity-uss", "uss", "modern", "":
		return "antigravity"
	default:
		return "antigravity"
	}
}

func resolveOAuthCreds(profile string) (clientId, clientSecret string) {
	if profile == "legacy" {
		return LEGACY_OAUTH_CLIENT_ID, LEGACY_OAUTH_CLIENT_SECRET
	}
	return ANTIGRAVITY_OAUTH_CLIENT_ID, ANTIGRAVITY_OAUTH_CLIENT_SECRET
}

func maskEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return email
	}
	name := parts[0]
	if len(name) <= 3 {
		return name + "***@" + parts[1]
	}
	return name[:3] + "***@" + parts[1]
}

// ─── OAuth2 Login Flow ──────────────────────────────────────────────────

const (
	// Scopes aligned with the plugin (rosettaProcess.ts / add-account.js)
	OAUTH_SCOPES = "https://www.googleapis.com/auth/cloud-platform " +
		"https://www.googleapis.com/auth/userinfo.email " +
		"https://www.googleapis.com/auth/userinfo.profile " +
		"https://www.googleapis.com/auth/cclog " +
		"https://www.googleapis.com/auth/experimentsandconfigs"
)

func generateOAuthState() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// OAuthLoginResult is the result of a successful OAuth login
type OAuthLoginResult struct {
	Email        string `json:"email"`
	RefreshToken string `json:"refreshToken"`
}

// StartOAuthLogin starts the OAuth2 authorization code flow:
// 1. Starts a temporary localhost HTTP server to receive the callback
// 2. Opens the browser to Google's authorization URL
// 3. Exchanges the auth code for tokens
// 4. Fetches user email via userinfo API
// 5. Returns email + refresh_token
func (p *AccountPool) StartOAuthLogin(profile string, openURL func(string)) (*OAuthLoginResult, error) {
	profile = normalizeOAuthProfile(profile)
	clientId, clientSecret := resolveOAuthCreds(profile)

	// Use random port (Google Desktop App OAuth allows any loopback port)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("无法启动 OAuth 回调服务: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", port)
	Log("[oauth] Callback server on port %d", port)

	// CSRF protection
	oauthState := generateOAuthState()

	// Channel to receive the auth code
	codeChan := make(chan string, 1)
	errChan := make(chan error, 1)

	// Create a temporary HTTP server for the OAuth callback
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		errParam := r.URL.Query().Get("error")
		returnedState := r.URL.Query().Get("state")

		if errParam != "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#18181c;color:#f3f4f6">
				<h2>❌ 授权失败</h2><p>%s</p><p>你可以关闭此页面</p></body></html>`, errParam)
			errChan <- fmt.Errorf("OAuth error: %s", errParam)
			return
		}

		if returnedState != oauthState {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#18181c;color:#f3f4f6">
				<h2>❌ 无效回调</h2><p>State 校验失败，请重试</p></body></html>`)
			errChan <- fmt.Errorf("OAuth state mismatch (CSRF check failed)")
			return
		}

		if code == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#18181c;color:#f3f4f6">
				<h2>❌ 未收到授权码</h2><p>你可以关闭此页面</p></body></html>`)
			errChan <- fmt.Errorf("no authorization code received")
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#18181c;color:#f3f4f6">
			<h2>✅ 授权成功</h2><p>正在导入账号，你可以关闭此页面...</p></body></html>`)
		codeChan <- code
	})

	server := &http.Server{Handler: mux}

	// Start the server using the already-bound listener
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errChan <- fmt.Errorf("OAuth callback server error: %w", err)
		}
	}()

	// Ensure server shuts down
	defer func() {
		go func() {
			time.Sleep(2 * time.Second)
			_ = server.Close()
		}()
	}()

	// Build the authorization URL (aligned with plugin rosettaProcess.ts)
	authURL := fmt.Sprintf(
		"https://accounts.google.com/o/oauth2/v2/auth?client_id=%s&redirect_uri=%s&response_type=code&scope=%s&access_type=offline&prompt=consent&include_granted_scopes=true&state=%s",
		url.QueryEscape(clientId),
		url.QueryEscape(redirectURI),
		url.QueryEscape(OAUTH_SCOPES),
		url.QueryEscape(oauthState),
	)

	Log("[oauth] Opening browser for OAuth login (profile: %s)", profile)
	openURL(authURL)

	// Wait for callback (timeout: 5 minutes)
	var authCode string
	select {
	case authCode = <-codeChan:
		Log("[oauth] Received authorization code")
	case err := <-errChan:
		return nil, err
	case <-time.After(5 * time.Minute):
		return nil, fmt.Errorf("OAuth login timed out (5 minutes)")
	}

	// Exchange auth code for tokens
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {authCode},
		"client_id":     {clientId},
		"client_secret": {clientSecret},
		"redirect_uri":  {redirectURI},
	}

	resp, err := p.httpClient.PostForm(GOOGLE_TOKEN_ENDPOINT, form)
	if err != nil {
		return nil, fmt.Errorf("token exchange network error: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token exchange failed: HTTP %d — %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		IDToken      string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("invalid token response: %w", err)
	}

	if tokenResp.RefreshToken == "" {
		return nil, fmt.Errorf("no refresh_token returned (已存在授权？尝试在 Google 账号设置中撤销应用访问后重试)")
	}

	// Fetch user email from userinfo API
	email, err := p.fetchUserEmail(tokenResp.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch user email: %w", err)
	}

	Log("[oauth] OAuth login successful: %s", email)
	return &OAuthLoginResult{
		Email:        email,
		RefreshToken: tokenResp.RefreshToken,
	}, nil
}

// fetchUserEmail gets the email from Google's userinfo endpoint
func (p *AccountPool) fetchUserEmail(accessToken string) (string, error) {
	req, err := http.NewRequest("GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("userinfo API returned %d: %s", resp.StatusCode, string(body))
	}

	var info struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return "", err
	}
	if info.Email == "" {
		return "", fmt.Errorf("no email in userinfo response")
	}
	return info.Email, nil
}

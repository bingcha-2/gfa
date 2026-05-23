package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ─── OAuth2 Credentials ─────────────────────────────────────────────────
// Desktop App credentials (not confidential per Google's docs)

const (
	GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

	LEGACY_OAUTH_CLIENT_ID     = "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com"
	LEGACY_OAUTH_CLIENT_SECRET = "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"

	ANTIGRAVITY_OAUTH_CLIENT_ID     = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
	ANTIGRAVITY_OAUTH_CLIENT_SECRET = "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"

	// Token refresh buffer: refresh 5 min before expiry
	REFRESH_BUFFER = 5 * time.Minute
)

// ─── AccountEntry ────────────────────────────────────────────────────────

type AccountEntry struct {
	ID                int               `json:"id"`
	Email             string            `json:"email"`
	RefreshToken      string            `json:"refreshToken"`
	Enabled           bool              `json:"enabled"`
	Alias             string            `json:"alias,omitempty"`
	ProjectId         string            `json:"projectId,omitempty"`
	PlanType          string            `json:"planType,omitempty"`
	OAuthProfile      string            `json:"oauthProfile,omitempty"` // "legacy" or "antigravity"

	// Runtime state (not persisted to accounts.json)
	accessToken       string
	accessTokenExpiry time.Time
	quotaStatus       string    // "ok", "exhausted"
	quotaReason       string
	exhaustedUntil    time.Time
	lastUsedAt        time.Time
	consecutiveErrors int
	blockedModels     map[string]time.Time // modelKey → blockedUntil
}

// ─── AccountPool ─────────────────────────────────────────────────────────

type AccountPool struct {
	mu            sync.RWMutex
	accounts      map[int]*AccountEntry
	nextId        int
	filePath      string
	httpClient    *http.Client
	lastRotateIdx int
}

var (
	poolOnce     sync.Once
	poolInstance *AccountPool
)

func GetAccountPool() *AccountPool {
	poolOnce.Do(func() {
		poolInstance = &AccountPool{
			accounts: make(map[int]*AccountEntry),
			nextId:   1,
			httpClient: &http.Client{
				Timeout: 20 * time.Second,
			},
		}
	})
	return poolInstance
}

// Init loads accounts from the config file path
func (p *AccountPool) Init() {
	p.mu.Lock()
	p.filePath = filepath.Join(getAppDataDir(), "accounts.json")
	p.mu.Unlock()
	p.LoadAccounts()
	Log("[account-pool] Initialized, %d account(s) loaded", p.Count())
}

// ─── Persistence ─────────────────────────────────────────────────────────

type accountsFileData struct {
	Accounts []accountFileEntry `json:"accounts"`
}

type accountFileEntry struct {
	ID           int    `json:"id"`
	Email        string `json:"email"`
	RefreshToken string `json:"refreshToken"`
	Enabled      bool   `json:"enabled"`
	Alias        string `json:"alias,omitempty"`
	ProjectId    string `json:"projectId,omitempty"`
	PlanType     string `json:"planType,omitempty"`
	OAuthProfile string `json:"oauthProfile,omitempty"`
}

func (p *AccountPool) LoadAccounts() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.filePath == "" {
		return
	}

	data, err := os.ReadFile(p.filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			Log("[account-pool] Error reading accounts file: %v", err)
		}
		return
	}

	var fileData accountsFileData
	if err := json.Unmarshal(data, &fileData); err != nil {
		Log("[account-pool] Error parsing accounts file: %v", err)
		return
	}

	maxId := 0
	for _, entry := range fileData.Accounts {
		if entry.Email == "" || entry.RefreshToken == "" {
			continue
		}
		id := entry.ID
		if id <= 0 {
			id = maxId + 1
		}
		if id > maxId {
			maxId = id
		}

		profile := normalizeOAuthProfile(entry.OAuthProfile)
		p.accounts[id] = &AccountEntry{
			ID:           id,
			Email:        entry.Email,
			RefreshToken: entry.RefreshToken,
			Enabled:      entry.Enabled,
			Alias:        entry.Alias,
			ProjectId:    entry.ProjectId,
			PlanType:     entry.PlanType,
			OAuthProfile: profile,
			quotaStatus:  "ok",
			blockedModels: make(map[string]time.Time),
		}
	}
	p.nextId = maxId + 1
}

func (p *AccountPool) SaveAccounts() {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.filePath == "" {
		return
	}

	var entries []accountFileEntry
	// Sort by ID for stable output
	ids := make([]int, 0, len(p.accounts))
	for id := range p.accounts {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	for _, id := range ids {
		acc := p.accounts[id]
		entries = append(entries, accountFileEntry{
			ID:           acc.ID,
			Email:        acc.Email,
			RefreshToken: acc.RefreshToken,
			Enabled:      acc.Enabled,
			Alias:        acc.Alias,
			ProjectId:    acc.ProjectId,
			PlanType:     acc.PlanType,
			OAuthProfile: acc.OAuthProfile,
		})
	}

	fileData := accountsFileData{Accounts: entries}
	data, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		Log("[account-pool] Error marshaling accounts: %v", err)
		return
	}

	dir := filepath.Dir(p.filePath)
	_ = os.MkdirAll(dir, 0700)

	tmpPath := p.filePath + ".tmp"
	if err := os.WriteFile(tmpPath, append(data, '\n'), 0600); err != nil {
		Log("[account-pool] Error writing accounts: %v", err)
		return
	}
	if err := os.Rename(tmpPath, p.filePath); err != nil {
		Log("[account-pool] Error renaming accounts file: %v", err)
	}
}

// ─── CRUD ────────────────────────────────────────────────────────────────

func (p *AccountPool) AddAccount(email, refreshToken, oauthProfile string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	email = strings.TrimSpace(email)
	refreshToken = strings.TrimSpace(refreshToken)

	if email == "" || refreshToken == "" {
		return 0, fmt.Errorf("email and refreshToken are required")
	}

	// Check duplicate
	for _, acc := range p.accounts {
		if strings.EqualFold(acc.Email, email) {
			return 0, fmt.Errorf("account %s already exists (ID #%d)", email, acc.ID)
		}
	}

	id := p.nextId
	p.nextId++

	profile := normalizeOAuthProfile(oauthProfile)

	p.accounts[id] = &AccountEntry{
		ID:            id,
		Email:         email,
		RefreshToken:  refreshToken,
		Enabled:       true,
		OAuthProfile:  profile,
		quotaStatus:   "ok",
		blockedModels: make(map[string]time.Time),
	}

	Log("[account-pool] Added account #%d: %s (profile: %s)", id, email, profile)

	go func() {
		p.SaveAccounts()
	}()

	return id, nil
}

func (p *AccountPool) RemoveAccount(id int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return fmt.Errorf("account #%d not found", id)
	}

	delete(p.accounts, id)
	Log("[account-pool] Removed account #%d: %s", id, acc.Email)

	go func() {
		p.SaveAccounts()
	}()

	return nil
}

func (p *AccountPool) ToggleAccount(id int, enabled bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return fmt.Errorf("account #%d not found", id)
	}

	acc.Enabled = enabled
	Log("[account-pool] Account #%d (%s) enabled=%v", id, acc.Email, enabled)

	go func() {
		p.SaveAccounts()
	}()

	return nil
}

func (p *AccountPool) Count() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.accounts)
}

func (p *AccountPool) EnabledCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	count := 0
	for _, acc := range p.accounts {
		if acc.Enabled {
			count++
		}
	}
	return count
}

// ─── OAuth2 Token Refresh ────────────────────────────────────────────────

func (p *AccountPool) RefreshAccessToken(acc *AccountEntry) (string, error) {
	clientId, clientSecret := resolveOAuthCreds(acc.OAuthProfile)

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {acc.RefreshToken},
		"client_id":     {clientId},
		"client_secret": {clientSecret},
	}

	resp, err := p.httpClient.PostForm(GOOGLE_TOKEN_ENDPOINT, form)
	if err != nil {
		acc.consecutiveErrors++
		return "", fmt.Errorf("token refresh network error: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		acc.consecutiveErrors++
		return "", fmt.Errorf("token refresh failed for %s: HTTP %d — %s", acc.Email, resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		ExpiresIn    int    `json:"expires_in"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("invalid token response: %w", err)
	}

	expiresIn := tokenResp.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}

	p.mu.Lock()
	acc.accessToken = tokenResp.AccessToken
	acc.accessTokenExpiry = time.Now().Add(time.Duration(expiresIn) * time.Second)
	acc.consecutiveErrors = 0

	// If Google issued a new refreshToken, update and persist
	if tokenResp.RefreshToken != "" && tokenResp.RefreshToken != acc.RefreshToken {
		acc.RefreshToken = tokenResp.RefreshToken
		go func() { p.SaveAccounts() }()
	}
	p.mu.Unlock()

	return tokenResp.AccessToken, nil
}

// GetAccessToken returns a valid access token, refreshing if needed
func (p *AccountPool) GetAccessToken(id int) (string, error) {
	p.mu.RLock()
	acc, ok := p.accounts[id]
	p.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("account #%d not found", id)
	}

	p.mu.RLock()
	hasValid := acc.accessToken != "" && time.Now().Add(REFRESH_BUFFER).Before(acc.accessTokenExpiry)
	token := acc.accessToken
	p.mu.RUnlock()

	if hasValid {
		return token, nil
	}

	return p.RefreshAccessToken(acc)
}

// ─── Account Selection ──────────────────────────────────────────────────

// SelectAccount picks the best available account for a request.
// Strategy: prefer enabled, non-exhausted, least-recently-used.
func (p *AccountPool) SelectAccount(modelKey string, excludeIds []int) (*AccountEntry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	excludeSet := make(map[int]bool, len(excludeIds))
	for _, id := range excludeIds {
		excludeSet[id] = true
	}

	var candidates []*AccountEntry
	for _, acc := range p.accounts {
		if !acc.Enabled || excludeSet[acc.ID] {
			continue
		}
		// Skip globally exhausted accounts
		if acc.quotaStatus == "exhausted" && now.Before(acc.exhaustedUntil) {
			continue
		}
		// Skip accounts blocked for this specific model
		if modelKey != "" {
			if blockedUntil, blocked := acc.blockedModels[modelKey]; blocked && now.Before(blockedUntil) {
				continue
			}
		}
		// Skip accounts with too many consecutive errors
		if acc.consecutiveErrors >= 5 {
			continue
		}
		candidates = append(candidates, acc)
	}

	if len(candidates) == 0 {
		total := len(p.accounts)
		enabled := 0
		for _, a := range p.accounts {
			if a.Enabled {
				enabled++
			}
		}
		return nil, fmt.Errorf("号池中无可用账号 (总数: %d, 启用: %d)", total, enabled)
	}

	// Sort by lastUsedAt (ascending) → pick least recently used
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].lastUsedAt.Before(candidates[j].lastUsedAt)
	})

	selected := candidates[0]
	selected.lastUsedAt = now
	return selected, nil
}

// MarkExhausted marks an account as quota-exhausted
func (p *AccountPool) MarkExhausted(id int, reason string, modelKey string, cooldownMinutes int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return
	}

	if cooldownMinutes <= 0 {
		cooldownMinutes = 60 // default 1 hour cooldown
	}

	now := time.Now()
	until := now.Add(time.Duration(cooldownMinutes) * time.Minute)

	if modelKey != "" {
		// Model-level block
		if acc.blockedModels == nil {
			acc.blockedModels = make(map[string]time.Time)
		}
		acc.blockedModels[modelKey] = until
		Log("[account-pool] Account #%d (%s) model %s blocked until %s, reason: %s",
			id, acc.Email, modelKey, until.Format("15:04:05"), reason)
	} else {
		// Global exhaustion
		acc.quotaStatus = "exhausted"
		acc.quotaReason = reason
		acc.exhaustedUntil = until
		Log("[account-pool] Account #%d (%s) exhausted until %s, reason: %s",
			id, acc.Email, until.Format("15:04:05"), reason)
	}
}

// MarkSuccess resets error counters after a successful request
func (p *AccountPool) MarkSuccess(id int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return
	}
	acc.consecutiveErrors = 0
	if acc.quotaStatus == "exhausted" && time.Now().After(acc.exhaustedUntil) {
		acc.quotaStatus = "ok"
		acc.quotaReason = ""
	}
}

// MarkError increments the error counter
func (p *AccountPool) MarkError(id int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return
	}
	acc.consecutiveErrors++
}

// ─── Status / Listing ────────────────────────────────────────────────────

type AccountInfo struct {
	ID              int               `json:"id"`
	Email           string            `json:"email"`
	Alias           string            `json:"alias"`
	Enabled         bool              `json:"enabled"`
	ProjectId       string            `json:"projectId"`
	PlanType        string            `json:"planType"`
	OAuthProfile    string            `json:"oauthProfile"`
	HasAccessToken  bool              `json:"hasAccessToken"`
	TokenExpiresIn  int               `json:"tokenExpiresIn"` // seconds
	QuotaStatus     string            `json:"quotaStatus"`
	QuotaReason     string            `json:"quotaReason"`
	ExhaustedUntil  string            `json:"exhaustedUntil,omitempty"`
	ConsecErrors    int               `json:"consecutiveErrors"`
	LastUsedAt      string            `json:"lastUsedAt,omitempty"`
	BlockedModels   map[string]string `json:"blockedModels,omitempty"`
}

func (p *AccountPool) ListAccounts() []AccountInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()

	now := time.Now()
	var list []AccountInfo

	ids := make([]int, 0, len(p.accounts))
	for id := range p.accounts {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	for _, id := range ids {
		acc := p.accounts[id]

		tokenExpiresIn := 0
		if acc.accessToken != "" && acc.accessTokenExpiry.After(now) {
			tokenExpiresIn = int(acc.accessTokenExpiry.Sub(now).Seconds())
		}

		info := AccountInfo{
			ID:             acc.ID,
			Email:          maskEmail(acc.Email),
			Alias:          acc.Alias,
			Enabled:        acc.Enabled,
			ProjectId:      acc.ProjectId,
			PlanType:       acc.PlanType,
			OAuthProfile:   acc.OAuthProfile,
			HasAccessToken: acc.accessToken != "" && acc.accessTokenExpiry.After(now),
			TokenExpiresIn: tokenExpiresIn,
			QuotaStatus:    acc.quotaStatus,
			QuotaReason:    acc.quotaReason,
			ConsecErrors:   acc.consecutiveErrors,
		}

		if acc.quotaStatus == "exhausted" && acc.exhaustedUntil.After(now) {
			info.ExhaustedUntil = acc.exhaustedUntil.Format(time.RFC3339)
		}
		if !acc.lastUsedAt.IsZero() {
			info.LastUsedAt = acc.lastUsedAt.Format(time.RFC3339)
		}

		// Blocked models
		if len(acc.blockedModels) > 0 {
			info.BlockedModels = make(map[string]string)
			for model, until := range acc.blockedModels {
				if until.After(now) {
					info.BlockedModels[model] = until.Format("15:04:05")
				}
			}
		}

		list = append(list, info)
	}

	return list
}

func (p *AccountPool) GetPoolStatus() map[string]interface{} {
	p.mu.RLock()
	defer p.mu.RUnlock()

	total := len(p.accounts)
	enabled := 0
	available := 0
	exhausted := 0
	withToken := 0
	now := time.Now()

	for _, acc := range p.accounts {
		if !acc.Enabled {
			continue
		}
		enabled++
		if acc.accessToken != "" && acc.accessTokenExpiry.After(now) {
			withToken++
		}
		if acc.quotaStatus == "exhausted" && now.Before(acc.exhaustedUntil) {
			exhausted++
		} else {
			available++
		}
	}

	return map[string]interface{}{
		"total":     total,
		"enabled":   enabled,
		"available": available,
		"exhausted": exhausted,
		"withToken": withToken,
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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

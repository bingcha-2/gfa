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
	"os"
	"os/exec"
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

// ─── Quota Data Structures ───────────────────────────────────────────────

// QuotaEntry 单个模型的额度信息
type QuotaEntry struct {
	Key       string  `json:"key"`       // 模型 key, e.g. "gemini-2.5-pro"
	Label     string  `json:"label"`     // 显示名
	Percent   float64 `json:"percent"`   // 剩余百分比 0-100
	IsBlocked bool    `json:"isBlocked"` // 是否已耗尽
	ResetTime string  `json:"resetTime"` // 重置时间 (ISO 8601)
	Provider  string  `json:"provider"`  // "gemini" / "claude" / "gpt" / "other"
}

// QuotaGroup 按 provider 分组的额度信息
type QuotaGroup struct {
	Provider     string       `json:"provider"`     // "gemini" / "claude" / "other"
	Percent      float64      `json:"percent"`      // 该组整体剩余百分比
	ResetTime    string       `json:"resetTime"`    // 组级重置时间
	ModelCount   int          `json:"modelCount"`
	BlockedCount int          `json:"blockedCount"`
	Entries      []QuotaEntry `json:"entries"`
}

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

	// 额度快照 (运行时，不持久化)
	quotaGroups      []QuotaGroup // 按 provider 分组的额度信息
	quotaRefreshedAt time.Time    // 最后一次额度刷新时间

	// 请求统计 (运行时，不持久化)
	successCount int // 成功请求数
	failureCount int // 失败请求数
	isActive     bool // 当前是否正在服务请求
}

// ─── AccountPool ─────────────────────────────────────────────────────────

type AccountPool struct {
	mu              sync.RWMutex
	accounts        map[int]*AccountEntry
	nextId          int
	filePath        string
	httpClient      *http.Client
	lastRotateIdx   int
	activeAccountId int // 当前正在服务的账号 ID
	lockedAccountId int // 锁定账号 ID，>0 时强制使用该账号（调试模式）
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

	// 锁定模式：强制使用锁定账号，不轮换
	if p.lockedAccountId > 0 {
		acc, ok := p.accounts[p.lockedAccountId]
		if !ok || !acc.Enabled {
			return nil, fmt.Errorf("锁定账号 #%d 不可用", p.lockedAccountId)
		}
		acc.lastUsedAt = now
		return acc, nil
	}

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
	// ── 新增字段 ──
	IsActive           bool             `json:"isActive"`
	SuccessRate        *float64         `json:"successRate"`        // 成功率百分比，nil 表示无数据
	QualityTier        string           `json:"qualityTier"`        // "excellent"/"good"/"poor"/"bad"/"new"
	RequestStats       RequestStatsInfo `json:"requestStats"`
	QuotaGroups        []QuotaGroup     `json:"quotaGroups"`
	QuotaRefreshedAt   string           `json:"quotaRefreshedAt,omitempty"`
	AccountStatusLabel string           `json:"accountStatusLabel"` // 状态文本标签
	AccountStatusTone  string           `json:"accountStatusTone"`  // "success"/"warning"/"danger"/"muted"
	IsLocked           bool             `json:"isLocked"`           // 是否被锁定（调试模式）
}

type RequestStatsInfo struct {
	Total     int `json:"total"`
	Successes int `json:"successes"`
	Failures  int `json:"failures"`
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

		// 计算成功率和质量等级
		totalReqs := acc.successCount + acc.failureCount
		var successRate *float64
		qualityTier := "new"
		if totalReqs >= 3 {
			rate := float64(acc.successCount) / float64(totalReqs) * 100
			successRate = &rate
			qualityTier = computeQualityTier(rate, totalReqs)
		}

		// 生成状态标签和色调
		statusLabel, statusTone := computeAccountStatus(acc, now)

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
			// 新增字段
			IsActive:           acc.isActive,
			SuccessRate:        successRate,
			QualityTier:        qualityTier,
			RequestStats:       RequestStatsInfo{Total: totalReqs, Successes: acc.successCount, Failures: acc.failureCount},
			QuotaGroups:        acc.quotaGroups,
			AccountStatusLabel: statusLabel,
			AccountStatusTone:  statusTone,
			IsLocked:           p.lockedAccountId == acc.ID,
		}

		if !acc.quotaRefreshedAt.IsZero() {
			info.QuotaRefreshedAt = acc.quotaRefreshedAt.Format(time.RFC3339)
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
					info.BlockedModels[model] = until.Format(time.RFC3339)
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
		"total":           total,
		"enabled":         enabled,
		"available":       available,
		"exhausted":       exhausted,
		"withToken":       withToken,
		"lockedAccountId": p.lockedAccountId,
	}
}

// ─── Quality / Status Helpers ────────────────────────────────────────────

// computeQualityTier 根据成功率和请求量计算质量等级
func computeQualityTier(successRate float64, totalReqs int) string {
	if totalReqs < 3 {
		return "new"
	}
	switch {
	case successRate >= 90:
		return "excellent"
	case successRate >= 70:
		return "good"
	case successRate >= 40:
		return "poor"
	default:
		return "bad"
	}
}

// computeAccountStatus 生成账号的状态文本标签和色调
func computeAccountStatus(acc *AccountEntry, now time.Time) (label string, tone string) {
	if !acc.Enabled {
		return "已禁用", "muted"
	}
	if acc.consecutiveErrors >= 5 {
		return "连续错误", "danger"
	}
	if acc.quotaStatus == "exhausted" && acc.exhaustedUntil.After(now) {
		remaining := acc.exhaustedUntil.Sub(now)
		mins := int(remaining.Minutes())
		if mins > 60 {
			return fmt.Sprintf("冷却 %dh%dm", mins/60, mins%60), "warning"
		}
		return fmt.Sprintf("冷却 %dm", mins), "warning"
	}
	// 检查模型级封锁
	blockedCount := 0
	for _, until := range acc.blockedModels {
		if until.After(now) {
			blockedCount++
		}
	}
	if blockedCount > 0 {
		return fmt.Sprintf("%d 模型受限", blockedCount), "warning"
	}
	if acc.isActive {
		return "使用中", "success"
	}
	if acc.accessToken != "" && acc.accessTokenExpiry.After(now) {
		return "就绪", "success"
	}
	return "待激活", "muted"
}

// RecordRequestStats 记录一次请求的成功/失败
func (p *AccountPool) RecordRequestStats(accountId int, success bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	acc, ok := p.accounts[accountId]
	if !ok {
		return
	}
	if success {
		acc.successCount++
	} else {
		acc.failureCount++
	}
}

// SetActiveAccount 标记当前活跃账号
func (p *AccountPool) SetActiveAccount(accountId int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// 先清除旧的活跃标记
	for _, acc := range p.accounts {
		acc.isActive = false
	}
	if acc, ok := p.accounts[accountId]; ok {
		acc.isActive = true
	}
	p.activeAccountId = accountId
}

// SetAccountAlias 设置账号别名
func (p *AccountPool) SetAccountAlias(accountId int, alias string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	acc, ok := p.accounts[accountId]
	if !ok {
		return fmt.Errorf("account %d not found", accountId)
	}
	acc.Alias = strings.TrimSpace(alias)
	go p.SaveAccounts()
	return nil
}

// LockAccount 锁定账号（调试模式），后续所有请求都使用该账号
func (p *AccountPool) LockAccount(accountId int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	acc, ok := p.accounts[accountId]
	if !ok {
		return fmt.Errorf("account %d not found", accountId)
	}
	if !acc.Enabled {
		return fmt.Errorf("account %d is disabled", accountId)
	}
	p.lockedAccountId = accountId
	Log("[account-pool] Locked account #%d (%s) — debug mode ON", accountId, acc.Email)
	return nil
}

// UnlockAccount 解除锁定，恢复自动轮换
func (p *AccountPool) UnlockAccount() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lockedAccountId > 0 {
		Log("[account-pool] Unlocked account #%d — debug mode OFF", p.lockedAccountId)
		p.lockedAccountId = 0
	}
}

// GetLockedAccountId 获取当前锁定的账号 ID（0 = 未锁定）
func (p *AccountPool) GetLockedAccountId() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lockedAccountId
}

// ─── Quota Refresh (主动采集) ────────────────────────────────────────────

// RefreshAllQuotas 对所有启用且有 projectId 的账号刷新额度快照
func (p *AccountPool) RefreshAllQuotas() int {
	p.mu.RLock()
	var targets []*AccountEntry
	for _, acc := range p.accounts {
		if acc.Enabled && acc.ProjectId != "" {
			targets = append(targets, acc)
		}
	}
	p.mu.RUnlock()

	updated := 0
	for _, acc := range targets {
		if err := p.refreshAccountQuota(acc); err != nil {
			Log("[quota-refresh] %s: %v", acc.Email, err)
		} else {
			updated++
		}
		time.Sleep(500 * time.Millisecond) // 错开请求避免并发
	}
	if updated > 0 {
		Log("[quota-refresh] %d/%d accounts updated", updated, len(targets))
	}
	return updated
}

// refreshAccountQuota 对单个账号调用 fetchAvailableModels 获取额度快照
func (p *AccountPool) refreshAccountQuota(acc *AccountEntry) error {
	// 刷新 access token
	token, err := p.GetAccessToken(acc.ID)
	if err != nil {
		return fmt.Errorf("token refresh: %w", err)
	}
	if acc.ProjectId == "" {
		return fmt.Errorf("no projectId")
	}

	// 调用 fetchAvailableModels API
	reqBody, _ := json.Marshal(map[string]string{"project": acc.ProjectId})
	apiUrl := DefaultCloudEndpoint + "/v1internal:fetchAvailableModels"
	req, err := http.NewRequest("POST", apiUrl, io.NopCloser(strings.NewReader(string(reqBody))))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "google-antigravity-ls/1.26.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("API request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body[:min(len(body), 200)]))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	// 解析模型列表并生成额度分组
	groups := parseModelsResponse(body)

	p.mu.Lock()
	if entry, ok := p.accounts[acc.ID]; ok {
		entry.quotaGroups = groups
		entry.quotaRefreshedAt = time.Now()
	}
	p.mu.Unlock()

	return nil
}

// parseModelsResponse 解析 fetchAvailableModels 的响应，提取模型额度信息
func parseModelsResponse(body []byte) []QuotaGroup {
	var resp struct {
		Models []struct {
			ModelName    string `json:"modelName"`
			DisplayName string `json:"displayName"`
			// 额度相关字段
			QuotaStatus struct {
				RemainingPercent float64 `json:"remainingPercent"` // 0-100
				IsBlocked        bool    `json:"isBlocked"`
				ResetTime        string  `json:"resetTime"`
			} `json:"quotaStatus"`
			// 有些 API 返回的是 rateLimits
			RateLimits []struct {
				Key             string  `json:"key"`
				Remaining       float64 `json:"remaining"`
				Limit           float64 `json:"limit"`
				ResetTime       string  `json:"resetTime"`
			} `json:"rateLimits"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		// 尝试宽松解析：只提取 models 数组
		var loose map[string]interface{}
		if json.Unmarshal(body, &loose) != nil {
			return nil
		}
		// 如果有 models 字段但格式不匹配，返回空
		return nil
	}

	if len(resp.Models) == 0 {
		return nil
	}

	// 按 provider 分组
	providerEntries := make(map[string][]QuotaEntry)
	for _, m := range resp.Models {
		provider := classifyProvider(m.ModelName)
		percent := m.QuotaStatus.RemainingPercent
		isBlocked := m.QuotaStatus.IsBlocked
		resetTime := m.QuotaStatus.ResetTime

		// 如果 quotaStatus 没有数据，尝试从 rateLimits 推断
		if percent == 0 && !isBlocked && len(m.RateLimits) > 0 {
			limit := m.RateLimits[0]
			if limit.Limit > 0 {
				percent = (limit.Remaining / limit.Limit) * 100
			}
			if limit.Remaining <= 0 {
				isBlocked = true
			}
			resetTime = limit.ResetTime
		}

		entry := QuotaEntry{
			Key:       m.ModelName,
			Label:     m.DisplayName,
			Percent:   percent,
			IsBlocked: isBlocked,
			ResetTime: resetTime,
			Provider:  provider,
		}
		if entry.Label == "" {
			entry.Label = m.ModelName
		}
		providerEntries[provider] = append(providerEntries[provider], entry)
	}

	// 构建 QuotaGroup
	var groups []QuotaGroup
	providerOrder := []string{"gemini", "claude", "gpt", "other"}
	for _, prov := range providerOrder {
		entries, ok := providerEntries[prov]
		if !ok {
			continue
		}
		blocked := 0
		totalPercent := 0.0
		var groupResetTime string
		for _, e := range entries {
			if e.IsBlocked {
				blocked++
			}
			totalPercent += e.Percent
			if e.ResetTime != "" && groupResetTime == "" {
				groupResetTime = e.ResetTime
			}
		}
		avgPercent := totalPercent / float64(len(entries))

		groups = append(groups, QuotaGroup{
			Provider:     prov,
			Percent:      avgPercent,
			ResetTime:    groupResetTime,
			ModelCount:   len(entries),
			BlockedCount: blocked,
			Entries:      entries,
		})
	}

	return groups
}

// classifyProvider 将模型名分类为 gemini/claude/gpt/other
func classifyProvider(modelName string) string {
	lower := strings.ToLower(modelName)
	if strings.Contains(lower, "gemini") || strings.Contains(lower, "pro") || strings.Contains(lower, "flash") {
		return "gemini"
	}
	if strings.Contains(lower, "claude") || strings.Contains(lower, "opus") || strings.Contains(lower, "sonnet") {
		return "claude"
	}
	if strings.Contains(lower, "gpt") || strings.Contains(lower, "o3") || strings.Contains(lower, "o4") {
		return "gpt"
	}
	return "other"
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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
func (p *AccountPool) StartOAuthLogin(profile string) (*OAuthLoginResult, error) {
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
	openBrowser(authURL)

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

// openBrowser opens a URL in the default browser
func openBrowser(url string) {
	// Windows: use cmd /c start
	cmd := exec.Command("cmd", "/c", "start", url)
	_ = cmd.Start()
}

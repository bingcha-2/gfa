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
	successCount int  // 成功请求数
	failureCount int  // 失败请求数
	isActive     bool // 当前是否正在服务请求

	// AI 积分 (运行时，不持久化)
	creditsKnown     bool    // 是否已获取积分信息
	creditsAvailable bool    // 积分是否可用
	creditAmount     float64 // 当前积分余额
	minCreditAmount  float64 // 最低使用积分
	paidTierID       string  // 付费套餐 ID

	// 请求后异步刷新用的 CAS flag
	healthRefreshing int32 // atomic: 0=空闲, 1=正在刷新
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

	// 自动设置第一个启用的账号为 active（前端展示用）
	p.mu.Lock()
	if p.activeAccountId == 0 {
		for _, acc := range p.accounts {
			if acc.Enabled {
				p.activeAccountId = acc.ID
				acc.isActive = true
				break
			}
		}
	}
	p.mu.Unlock()

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

		p.accounts[id] = &AccountEntry{
			ID:           id,
			Email:        entry.Email,
			RefreshToken: entry.RefreshToken,
			Enabled:      entry.Enabled,
			Alias:        entry.Alias,
			ProjectId:    entry.ProjectId,
			PlanType:     entry.PlanType,
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
		})
	}

	fileData := accountsFileData{Accounts: entries}
	data, err := json.MarshalIndent(fileData, "", "  ")
	if err != nil {
		Log("[account-pool] Error marshaling accounts: %v", err)
		return
	}

	// Atomic + durable (temp file + fsync + rename) so a crash/power-loss can't
	// leave a half-written or truncated accounts file.
	if err := writeFileAtomic(p.filePath, append(data, '\n'), 0600); err != nil {
		Log("[account-pool] Error writing accounts: %v", err)
	}
}

// ─── CRUD ────────────────────────────────────────────────────────────────

func (p *AccountPool) AddAccount(email, refreshToken string) (int, error) {
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

	p.accounts[id] = &AccountEntry{
		ID:            id,
		Email:         email,
		RefreshToken:  refreshToken,
		Enabled:       true,
		quotaStatus:   "ok",
		blockedModels: make(map[string]time.Time),
	}

	Log("[account-pool] Added account #%d: %s", id, email)

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
	clientId, clientSecret := resolveOAuthCreds()

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
// Strategy: prefer 5h model quota > unknown > credits-only, then LRU within each tier.
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

	// Sort by quotaTier (ascending) first, then LRU within same tier.
	// tier 0: has 5h model quota → tier 1: unknown → tier 2: quota exhausted (credits only)
	sort.Slice(candidates, func(i, j int) bool {
		tierI := candidates[i].quotaTier(modelKey)
		tierJ := candidates[j].quotaTier(modelKey)
		if tierI != tierJ {
			return tierI < tierJ
		}
		return candidates[i].lastUsedAt.Before(candidates[j].lastUsedAt)
	})

	selected := candidates[0]
	tier := selected.quotaTier(modelKey)
	selected.lastUsedAt = now
	if tier == 2 {
		Log("[account-pool] Selected #%d (tier=%d: credits-only, no 5h quota for %s)", selected.ID, tier, modelKey)
	} else if tier == 0 {
		Log("[account-pool] Selected #%d (tier=%d: has 5h quota for %s)", selected.ID, tier, modelKey)
	}
	return selected, nil
}

// quotaTier classifies an account into selection priority tiers based on model quota data.
//   - tier 0: has 5h model quota remaining (remainingFraction > 0)
//   - tier 1: no quota data available (never refreshed) — treated as possibly having quota
//   - tier 2: model quota exhausted (remainingFraction == 0), will consume credits
func (acc *AccountEntry) quotaTier(modelKey string) int {
	if len(acc.quotaGroups) == 0 {
		return 1 // no quota data → unknown, medium priority
	}
	if modelKey == "" {
		return 1 // no model specified → can't check
	}
	for _, group := range acc.quotaGroups {
		for _, entry := range group.Entries {
			if matchModelKey(entry.Key, modelKey) {
				if entry.Percent > 0 {
					return 0 // has 5h quota
				}
				return 2 // quota exhausted
			}
		}
	}
	return 1 // model not found in quota data → unknown
}

// matchModelKey checks if a quota entry key matches the requested model key.
// Supports exact match and substring containment for flexibility
// (e.g. "gemini-2.5-pro" matches "gemini-2.5-pro-preview").
func matchModelKey(quotaKey, requestKey string) bool {
	if quotaKey == requestKey {
		return true
	}
	qLower := strings.ToLower(quotaKey)
	rLower := strings.ToLower(requestKey)
	return strings.Contains(qLower, rLower) || strings.Contains(rLower, qLower)
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

// ClearAccessToken clears the cached access token for an account,
// forcing a refresh on the next GetAccessToken call.
// Used when Google returns 401 (token expired/revoked).
func (p *AccountPool) ClearAccessToken(id int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	acc, ok := p.accounts[id]
	if !ok {
		return
	}
	acc.accessToken = ""
	acc.accessTokenExpiry = time.Time{}
}

// ─── Status / Listing ────────────────────────────────────────────────────

type AccountInfo struct {
	ID              int               `json:"id"`
	Email           string            `json:"email"`
	Alias           string            `json:"alias"`
	Enabled         bool              `json:"enabled"`
	ProjectId       string            `json:"projectId"`
	PlanType        string            `json:"planType"`
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
	Credits            *CreditsInfo     `json:"credits"`            // AI 积分信息
}

type CreditsInfo struct {
	Known           bool    `json:"known"`           // 是否已获取
	Available       bool    `json:"available"`       // 是否可用
	CreditAmount    float64 `json:"creditAmount"`    // 当前余额
	MinCreditAmount float64 `json:"minCreditAmount"` // 最低使用量
	PaidTierID      string  `json:"paidTierID"`      // 付费套餐 ID
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

		// 积分信息
		if acc.creditsKnown {
			info.Credits = &CreditsInfo{
				Known:           true,
				Available:       acc.creditsAvailable,
				CreditAmount:    acc.creditAmount,
				MinCreditAmount: acc.minCreditAmount,
				PaidTierID:      acc.paidTierID,
			}
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


package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	selfAccountVaultVersion  = 1
	selfAccountVaultFile     = "self-accounts.vault"
	selfAccountAlertDefault  = 20
	selfAccountQuotaTimeout  = 20 * time.Second
	selfAccountLoginTimeout  = 10 * time.Minute
	selfAccountReloadTimeout = 8 * time.Second
	selfAccountQuotaURL      = "https://chatgpt.com/backend-api/wham/usage"
)

var selfAccountsMu sync.Mutex

// Kept as a request seam for unit tests. The production request URL above is fixed
// so a local environment variable cannot redirect a user's OAuth token elsewhere.
var selfAccountQuotaDo = func(req *http.Request) (*http.Response, error) {
	return (&http.Client{Timeout: selfAccountQuotaTimeout}).Do(req)
}

type selfAccountQuotaWindow struct {
	Remaining int   `json:"remaining"`
	ResetAt   int64 `json:"resetAt"`
	Known     bool  `json:"known"`
}

type selfAccountQuota struct {
	FiveHour  *selfAccountQuotaWindow `json:"fiveHour,omitempty"`
	Weekly    *selfAccountQuotaWindow `json:"weekly,omitempty"`
	FetchedAt int64                   `json:"fetchedAt,omitempty"`
	Error     string                  `json:"error,omitempty"`
}

type selfAccountRecord struct {
	ID         string            `json:"id"`
	Alias      string            `json:"alias,omitempty"`
	Email      string            `json:"email,omitempty"`
	AccountID  string            `json:"accountId"`
	PlanType   string            `json:"planType,omitempty"`
	Auth       []byte            `json:"auth"`
	Quota      *selfAccountQuota `json:"quota,omitempty"`
	CreatedAt  int64             `json:"createdAt"`
	UpdatedAt  int64             `json:"updatedAt"`
	LastUsedAt int64             `json:"lastUsedAt,omitempty"`
}

type selfAccountVault struct {
	Version        int                 `json:"version"`
	ActiveID       string              `json:"activeId,omitempty"`
	AlertEnabled   bool                `json:"alertEnabled"`
	AlertThreshold int                 `json:"alertThreshold"`
	Accounts       []selfAccountRecord `json:"accounts"`
}

func defaultSelfAccountVault() *selfAccountVault {
	return &selfAccountVault{Version: selfAccountVaultVersion, AlertEnabled: true, AlertThreshold: selfAccountAlertDefault, Accounts: []selfAccountRecord{}}
}

func selfAccountVaultPath() string { return filepath.Join(getAppDataDir(), selfAccountVaultFile) }

func loadSelfAccountVault() (*selfAccountVault, error) {
	data, err := os.ReadFile(selfAccountVaultPath())
	if os.IsNotExist(err) {
		return defaultSelfAccountVault(), nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := unprotectSelfAccountVault(data)
	if err != nil {
		return nil, err
	}
	var vault selfAccountVault
	if err := json.Unmarshal(plain, &vault); err != nil {
		return nil, fmt.Errorf("本地账号库已损坏: %w", err)
	}
	if vault.Version != selfAccountVaultVersion {
		return nil, fmt.Errorf("暂不支持此本地账号库版本")
	}
	if vault.AlertThreshold < 1 || vault.AlertThreshold > 100 {
		vault.AlertThreshold = selfAccountAlertDefault
	}
	if vault.Accounts == nil {
		vault.Accounts = []selfAccountRecord{}
	}
	return &vault, nil
}

func saveSelfAccountVault(vault *selfAccountVault) error {
	if err := os.MkdirAll(getAppDataDir(), 0o700); err != nil {
		return err
	}
	plain, err := json.Marshal(vault)
	if err != nil {
		return err
	}
	protected, err := protectSelfAccountVault(plain)
	if err != nil {
		return err
	}
	return writeFileAtomic(selfAccountVaultPath(), protected, 0o600)
}

func decodeSelfAccountJWT(token string) map[string]interface{} {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]interface{}
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}

func selfAccountMetadata(identity codexOAuthIdentity) (email, plan string) {
	for _, token := range []string{identity.IDToken, identity.AccessToken} {
		claims := decodeSelfAccountJWT(token)
		if claims == nil {
			continue
		}
		if email == "" {
			email, _ = claims["email"].(string)
		}
		auth, _ := claims["https://api.openai.com/auth"].(map[string]interface{})
		if plan == "" && auth != nil {
			plan, _ = auth["chatgpt_plan_type"].(string)
		}
	}
	return strings.TrimSpace(email), strings.TrimSpace(plan)
}

func selfAccountID(identity codexOAuthIdentity) string {
	key := strings.TrimSpace(identity.AccountID)
	if key == "" {
		key = identity.AccessToken
	}
	digest := sha256.Sum256([]byte(key))
	return hex.EncodeToString(digest[:12])
}

func selfAccountIndex(vault *selfAccountVault, id string) int {
	for i := range vault.Accounts {
		if vault.Accounts[i].ID == id {
			return i
		}
	}
	return -1
}

func upsertSelfAccount(vault *selfAccountVault, identity codexOAuthIdentity, alias string, markActive bool) *selfAccountRecord {
	now := time.Now().UnixMilli()
	id := selfAccountID(identity)
	email, plan := selfAccountMetadata(identity)
	idx := selfAccountIndex(vault, id)
	if idx < 0 {
		vault.Accounts = append(vault.Accounts, selfAccountRecord{ID: id, CreatedAt: now})
		idx = len(vault.Accounts) - 1
	}
	record := &vault.Accounts[idx]
	record.AccountID = identity.AccountID
	record.Email = email
	if plan != "" {
		record.PlanType = plan
	}
	record.Auth = append(record.Auth[:0], identity.Raw...)
	record.UpdatedAt = now
	if strings.TrimSpace(alias) != "" {
		record.Alias = strings.TrimSpace(alias)
	}
	if markActive {
		vault.ActiveID = id
		record.LastUsedAt = now
	}
	return record
}

func syncCurrentSelfAccount(vault *selfAccountVault) (string, error) {
	identity, ok, err := currentCodexOAuthIdentity()
	if err != nil {
		return "", err
	}
	if !ok {
		vault.ActiveID = ""
		return "", nil
	}
	id := selfAccountID(identity)
	if selfAccountIndex(vault, id) >= 0 {
		upsertSelfAccount(vault, identity, "", true)
		return id, nil
	}
	vault.ActiveID = ""
	return "", nil
}

func selfAccountView(record selfAccountRecord, activeID string) map[string]interface{} {
	return map[string]interface{}{
		"id": record.ID, "alias": record.Alias, "email": record.Email, "accountId": record.AccountID,
		"planType": record.PlanType, "current": record.ID == activeID, "quota": record.Quota,
		"createdAt": record.CreatedAt, "updatedAt": record.UpdatedAt, "lastUsedAt": record.LastUsedAt,
	}
}

func selfAccountState(vault *selfAccountVault) map[string]interface{} {
	accounts := append([]selfAccountRecord(nil), vault.Accounts...)
	sort.SliceStable(accounts, func(i, j int) bool {
		if accounts[i].ID == vault.ActiveID {
			return true
		}
		if accounts[j].ID == vault.ActiveID {
			return false
		}
		return accounts[i].LastUsedAt > accounts[j].LastUsedAt
	})
	views := make([]map[string]interface{}, 0, len(accounts))
	for _, account := range accounts {
		views = append(views, selfAccountView(account, vault.ActiveID))
	}
	return map[string]interface{}{
		"accounts": views,
		"activeId": vault.ActiveID,
		"alert":    map[string]interface{}{"enabled": vault.AlertEnabled, "threshold": vault.AlertThreshold},
		"storage":  map[string]interface{}{"localOnly": true, "encrypted": true},
	}
}

// GetSelfAccountState only reads local encrypted state. It never sends account data to BingchaAI servers.
func (a *App) GetSelfAccountState() (map[string]interface{}, error) {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	if _, err := syncCurrentSelfAccount(vault); err != nil {
		return nil, fmt.Errorf("读取当前 Codex 登录失败: %w", err)
	}
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountState(vault), nil
}

func (a *App) SaveCurrentSelfAccount(alias string) (map[string]interface{}, error) {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	identity, ok, err := currentCodexOAuthIdentity()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("未检测到完整的 Codex ChatGPT 登录，请先在官方 Codex 中登录")
	}
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	record := upsertSelfAccount(vault, identity, alias, true)
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountView(*record, vault.ActiveID), nil
}

func importSelfAccountAuthData(data []byte, alias string) (map[string]interface{}, error) {
	identity, ok := parseCodexOAuthIdentity(data)
	if !ok {
		return nil, fmt.Errorf("所选文件不是完整的 Codex ChatGPT 登录文件")
	}
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	record := upsertSelfAccount(vault, identity, alias, false)
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountView(*record, vault.ActiveID), nil
}

func (a *App) ImportSelfAccountAuth() (map[string]interface{}, error) {
	path, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:   "选择 Codex auth.json",
		Filters: []wailsruntime.FileFilter{{DisplayName: "Codex 登录文件", Pattern: "*.json"}},
	})
	if err != nil || strings.TrimSpace(path) == "" {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	return importSelfAccountAuthData(data, "")
}

func replaceEnvValue(env []string, key, value string) []string {
	prefix := strings.ToUpper(key) + "="
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if strings.HasPrefix(strings.ToUpper(item), prefix) {
			continue
		}
		out = append(out, item)
	}
	return append(out, key+"="+value)
}

func (a *App) LoginNewSelfAccount() (map[string]interface{}, error) {
	cli := detectCodexCLIPath()
	if cli == "" {
		return nil, fmt.Errorf("未检测到 Codex CLI，无法启动官方登录")
	}
	if err := os.MkdirAll(getAppDataDir(), 0o700); err != nil {
		return nil, err
	}
	tempHome, err := os.MkdirTemp(getAppDataDir(), "self-account-login-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempHome)
	cmd := hideCmd(cli, "login", "-c", `cli_auth_credentials_store="file"`)
	cmd.Env = replaceEnvValue(os.Environ(), "CODEX_HOME", tempHome)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("无法启动 Codex 官方登录: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return nil, fmt.Errorf("Codex 登录未完成: %s", strings.TrimSpace(output.String()))
		}
	case <-time.After(selfAccountLoginTimeout):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("Codex 登录等待超时，请重新尝试")
	}
	data, err := os.ReadFile(filepath.Join(tempHome, "auth.json"))
	if err != nil {
		return nil, fmt.Errorf("登录完成但未找到 Codex 凭证: %w", err)
	}
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	return importSelfAccountAuthData(data, "")
}

type selfAccountLiveBackup struct {
	file       []byte
	fileExists bool
	keychain   string
	keyExists  bool
}

func captureSelfAccountLiveBackup() (selfAccountLiveBackup, error) {
	var backup selfAccountLiveBackup
	data, err := os.ReadFile(codexAuthPath())
	if err == nil {
		backup.file, backup.fileExists = data, true
	} else if !os.IsNotExist(err) {
		return backup, err
	}
	if runtimeGOOSIsDarwin() {
		secret, existed, err := readCodexKeychainSecret()
		if err != nil {
			return backup, err
		}
		backup.keychain, backup.keyExists = secret, existed
	}
	return backup, nil
}

func runtimeGOOSIsDarwin() bool { return strings.EqualFold(runtimeGOOS(), "darwin") }

// runtimeGOOS is a seam for small unit tests without changing platform behavior.
var runtimeGOOS = func() string { return goruntime.GOOS }

func restoreSelfAccountLiveBackup(backup selfAccountLiveBackup) error {
	var restoreErrors []error
	if backup.fileExists {
		if err := writeFileAtomic(codexAuthPath(), backup.file, 0o600); err != nil {
			restoreErrors = append(restoreErrors, fmt.Errorf("恢复 auth.json 失败: %w", err))
		}
	} else {
		if err := os.Remove(codexAuthPath()); err != nil && !os.IsNotExist(err) {
			restoreErrors = append(restoreErrors, fmt.Errorf("清理 auth.json 失败: %w", err))
		}
	}
	if runtimeGOOSIsDarwin() {
		if backup.keyExists {
			if err := writeCodexKeychainSecret(backup.keychain); err != nil {
				restoreErrors = append(restoreErrors, fmt.Errorf("恢复 Keychain 登录失败: %w", err))
			}
		} else {
			if err := deleteCodexKeychainSecret(); err != nil {
				restoreErrors = append(restoreErrors, fmt.Errorf("清理 Keychain 登录失败: %w", err))
			}
		}
	}
	return errors.Join(restoreErrors...)
}

func projectSelfAccountAuth(raw []byte) error {
	if !json.Valid(raw) {
		return fmt.Errorf("目标账号凭证格式无效")
	}
	if err := os.MkdirAll(codexHomeDir(), 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(codexAuthPath(), raw, 0o600); err != nil {
		return err
	}
	if runtimeGOOSIsDarwin() {
		if err := writeCodexKeychainSecret(string(raw)); err != nil {
			return err
		}
	}
	return nil
}

func reloadCodexForSelfAccountSwitch(wasRunning bool) string {
	if appActionsSuppressed() {
		return "not_running"
	}
	if cli := detectCodexCLIPath(); cli != "" {
		ctx, cancel := context.WithTimeout(context.Background(), selfAccountReloadTimeout)
		defer cancel()
		cmd := hideCmdContext(ctx, cli, "app-server", "daemon", "restart")
		cmd.Env = replaceEnvValue(os.Environ(), "CODEX_HOME", codexHomeDir())
		if err := cmd.Run(); err == nil {
			return "daemon_restarted"
		}
	}
	if !wasRunning {
		return "not_running"
	}
	QuitCodexApp()
	LaunchCodexApp()
	return "app_restarted"
}

func hasCodexTakeoverArtifacts() bool {
	if IsCodexInjected(effectiveProxyPort()) || isCodexManagedProvider(currentCodexModelProvider()) {
		return true
	}
	if _, err := os.Stat(codexBackupPath()); err == nil || !os.IsNotExist(err) {
		return true
	}
	config, had, err := loadCodexConfig()
	if err != nil || !had {
		return false
	}
	providers, _ := config["model_providers"].(map[string]interface{})
	_, hasRemote := providers[codexProviderID]
	_, hasLocal := providers[codexLocalProviderID]
	return hasRemote || hasLocal
}

func persistCurrentSelfAccountBeforeSwitch(vault *selfAccountVault) error {
	identity, ok, err := currentCodexOAuthIdentity()
	if err != nil {
		return fmt.Errorf("读取当前 Codex 登录失败: %w", err)
	}
	if ok {
		upsertSelfAccount(vault, identity, "", true)
	} else {
		vault.ActiveID = ""
	}
	if err := saveSelfAccountVault(vault); err != nil {
		return fmt.Errorf("保存当前账号最新凭证失败: %w", err)
	}
	return nil
}

func selfAccountSwitchFailure(cause error, backup selfAccountLiveBackup) error {
	if rollbackErr := restoreSelfAccountLiveBackup(backup); rollbackErr != nil {
		return fmt.Errorf("%v；恢复原账号也失败: %w", cause, rollbackErr)
	}
	return fmt.Errorf("%w，已恢复原账号", cause)
}

func (a *App) SwitchSelfAccount(id string) (map[string]interface{}, error) {
	wasRunning := IsCodexRunning()
	id = strings.TrimSpace(id)
	selfAccountsMu.Lock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		selfAccountsMu.Unlock()
		return nil, err
	}
	preflightIdx := selfAccountIndex(vault, id)
	if preflightIdx < 0 {
		selfAccountsMu.Unlock()
		return nil, fmt.Errorf("没有找到这个自有账号")
	}
	if _, ok := parseCodexOAuthIdentity(vault.Accounts[preflightIdx].Auth); !ok {
		selfAccountsMu.Unlock()
		return nil, fmt.Errorf("目标账号凭证不完整，请重新导入或保存")
	}

	takeoverDisabled := false
	if hasCodexTakeoverArtifacts() {
		if _, err := (codexTarget{}).Restore(); err != nil {
			selfAccountsMu.Unlock()
			return nil, fmt.Errorf("切换自有账号前停止 Codex 接管失败: %w", err)
		}
		takeoverDisabled = true
		wasRunning = true
	}

	if err := persistCurrentSelfAccountBeforeSwitch(vault); err != nil {
		selfAccountsMu.Unlock()
		return nil, err
	}
	idx := selfAccountIndex(vault, id)
	if idx < 0 {
		selfAccountsMu.Unlock()
		return nil, fmt.Errorf("没有找到这个自有账号")
	}
	target := &vault.Accounts[idx]
	backup, err := captureSelfAccountLiveBackup()
	if err != nil {
		selfAccountsMu.Unlock()
		return nil, err
	}
	if err := projectSelfAccountAuth(target.Auth); err != nil {
		switchErr := selfAccountSwitchFailure(fmt.Errorf("写入目标账号失败: %w", err), backup)
		selfAccountsMu.Unlock()
		return nil, switchErr
	}
	actual, ok, verifyErr := currentCodexOAuthIdentity()
	if verifyErr != nil || !ok || selfAccountID(actual) != target.ID {
		cause := errors.New("切换后账号校验失败")
		if verifyErr != nil {
			cause = fmt.Errorf("切换后账号校验失败: %w", verifyErr)
		}
		switchErr := selfAccountSwitchFailure(cause, backup)
		selfAccountsMu.Unlock()
		return nil, switchErr
	}
	now := time.Now().UnixMilli()
	vault.ActiveID, target.LastUsedAt, target.UpdatedAt = target.ID, now, now
	if err := saveSelfAccountVault(vault); err != nil {
		switchErr := selfAccountSwitchFailure(fmt.Errorf("保存切换状态失败: %w", err), backup)
		selfAccountsMu.Unlock()
		return nil, switchErr
	}
	view := selfAccountView(*target, vault.ActiveID)
	selfAccountsMu.Unlock()

	reloadMode := reloadCodexForSelfAccountSwitch(wasRunning)
	return map[string]interface{}{"account": view, "reloadMode": reloadMode, "takeoverDisabled": takeoverDisabled}, nil
}

func (a *App) UpdateSelfAccountAlias(id, alias string) error {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return err
	}
	idx := selfAccountIndex(vault, id)
	if idx < 0 {
		return fmt.Errorf("没有找到这个自有账号")
	}
	vault.Accounts[idx].Alias = strings.TrimSpace(alias)
	vault.Accounts[idx].UpdatedAt = time.Now().UnixMilli()
	return saveSelfAccountVault(vault)
}

func (a *App) DeleteSelfAccount(id string) error {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return err
	}
	idx := selfAccountIndex(vault, id)
	if idx < 0 {
		return nil
	}
	vault.Accounts = append(vault.Accounts[:idx], vault.Accounts[idx+1:]...)
	if vault.ActiveID == id {
		vault.ActiveID = ""
	}
	return saveSelfAccountVault(vault)
}

func (a *App) SetSelfAccountAlertConfig(enabled bool, threshold int) (map[string]interface{}, error) {
	if threshold < 1 {
		threshold = 1
	}
	if threshold > 100 {
		threshold = 100
	}
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	vault.AlertEnabled, vault.AlertThreshold = enabled, threshold
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountState(vault), nil
}

func fetchSelfAccountQuota(record *selfAccountRecord) (*selfAccountQuota, error) {
	identity, ok := parseCodexOAuthIdentity(record.Auth)
	if !ok {
		return nil, fmt.Errorf("账号凭证不完整，请重新保存")
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, selfAccountQuotaURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+identity.AccessToken)
	req.Header.Set("Accept", "application/json")
	if identity.AccountID != "" {
		req.Header.Set("ChatGPT-Account-Id", identity.AccountID)
	}
	resp, err := selfAccountQuotaDo(req)
	if err != nil {
		return nil, fmt.Errorf("额度请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("登录已失效，请切换到该账号后重新登录")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("额度服务返回 %d", resp.StatusCode)
	}
	var usage codexUsageResponse
	if err := json.Unmarshal(body, &usage); err != nil {
		return nil, fmt.Errorf("无法解析额度数据")
	}
	window := parseCodexUsage(&usage)
	if window == nil {
		return nil, fmt.Errorf("官方暂未返回额度窗口")
	}
	quota := &selfAccountQuota{FetchedAt: time.Now().UnixMilli()}
	if window.HourlyPresent != nil && *window.HourlyPresent && window.HourlyPercent >= 0 {
		quota.FiveHour = &selfAccountQuotaWindow{Remaining: int(window.HourlyPercent + 0.5), ResetAt: parseResetISOToMillis(window.HourlyResetTime), Known: true}
	}
	if window.WeeklyPresent != nil && *window.WeeklyPresent && window.WeeklyPercent >= 0 {
		quota.Weekly = &selfAccountQuotaWindow{Remaining: int(window.WeeklyPercent + 0.5), ResetAt: parseResetISOToMillis(window.WeeklyResetTime), Known: true}
	}
	if usage.PlanType != "" {
		record.PlanType = usage.PlanType
	}
	return quota, nil
}

func parseResetISOToMillis(value string) int64 {
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed.UnixMilli()
	}
	return 0
}

func (a *App) RefreshSelfAccountQuotas(activeOnly bool) (map[string]interface{}, error) {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	if _, err := syncCurrentSelfAccount(vault); err != nil {
		return nil, fmt.Errorf("读取当前 Codex 登录失败: %w", err)
	}
	for i := range vault.Accounts {
		if activeOnly && vault.Accounts[i].ID != vault.ActiveID {
			continue
		}
		quota, quotaErr := fetchSelfAccountQuota(&vault.Accounts[i])
		if quotaErr != nil {
			if vault.Accounts[i].Quota == nil {
				vault.Accounts[i].Quota = &selfAccountQuota{}
			}
			vault.Accounts[i].Quota.Error = quotaErr.Error()
			continue
		}
		vault.Accounts[i].Quota = quota
		vault.Accounts[i].UpdatedAt = time.Now().UnixMilli()
	}
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountState(vault), nil
}

func (a *App) RefreshSelfAccountQuota(id string) (map[string]interface{}, error) {
	selfAccountsMu.Lock()
	defer selfAccountsMu.Unlock()
	vault, err := loadSelfAccountVault()
	if err != nil {
		return nil, err
	}
	if _, err := syncCurrentSelfAccount(vault); err != nil {
		return nil, fmt.Errorf("读取当前 Codex 登录失败: %w", err)
	}
	idx := selfAccountIndex(vault, id)
	if idx < 0 {
		return nil, fmt.Errorf("没有找到这个自有账号")
	}
	quota, err := fetchSelfAccountQuota(&vault.Accounts[idx])
	if err != nil {
		if vault.Accounts[idx].Quota == nil {
			vault.Accounts[idx].Quota = &selfAccountQuota{}
		}
		vault.Accounts[idx].Quota.Error = err.Error()
		_ = saveSelfAccountVault(vault)
		return nil, err
	}
	vault.Accounts[idx].Quota = quota
	vault.Accounts[idx].UpdatedAt = time.Now().UnixMilli()
	if err := saveSelfAccountVault(vault); err != nil {
		return nil, err
	}
	return selfAccountView(vault.Accounts[idx], vault.ActiveID), nil
}

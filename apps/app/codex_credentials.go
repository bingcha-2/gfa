package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ─── 伪 ~/.codex/auth.json 注入：让未登录的 Codex 跳过登录页 ──────────────────
//
// 对标 Claude 的 InjectFakeClaudeCredentials(mitm_credentials.go)。Codex 接管走自定义
// provider 模式(config.toml 的 base_url 指向本地代理,requires_openai_auth=false),但
// Codex GUI 启动时仍会读 ~/.codex/auth.json 判断登录态:没有有效登录就卡在登录页,进不到
// 能用自定义 provider 的主界面。本文件在接管时写一份"伪登录态",让它以为已登录、直接可用。
//
// 注意:以上是旧版设计。新版 Desktop 会把伪 JWT 拿去官方 wham/settings
// 验签,导致 401 白屏;现在远程接管已改用 requires_openai_auth=false 的自定义
// provider，不再调用 InjectFakeCodexAuth。本文件只保留迁移/回归能力。
//
// 为什么旧伪凭证脱离代理后不可用:
//   - Codex 不验 JWT 签名(实测 codex-rs login/src/token_data.rs 的 decode_jwt_payload 只
//     split('.') 取 payload,签名段丢弃),所以这里写"签名是乱码、payload 合法"的假 JWT 即可
//     骗过本地登录判定 —— 但这种 token 对真 chatgpt.com 天然无效(官方验签)。
//   - 真正打上游的号池 token 只在 CodexProxy 转发的那一刻注入 Authorization 头,从不落地到
//     auth.json。所以即便本文件残留,用户拿它直连官方也只是一把废钥匙。
//
// 为什么不劫持刷新端点(CODEX_REFRESH_TOKEN_URL_OVERRIDE):
//   伪 token 的 exp 设 1 年远 → Codex 的 stale 检测(过期前 5 分钟才刷新)在 session 周期内
//   永不触发,故无需把刷新导向代理。env 注入对 `open` 拉起的 GUI 也不可靠。真机若发现仍触发
//   刷新弹登录,再补 /oauth/token 伪刷新端点 + env 注入。
//
// 备份/还原与幂等策略对齐 Cockpit 的受管账号投影:注入前把原 auth.json
// 状态(存在与否 + 原内容)备份到 .bcai-codex-creds-backup.json;macOS 同时备份
// Codex Auth keychain。取消接管时精确还原;已注入则不重复备份(不把自己写的伪凭证
// 当成"用户原值")。

// codexFakeEmail 是伪登录态对外显示的占位邮箱(Codex 主界面"已登录为 xxx")。
const codexFakeEmail = "codex@bingchaai.app"

const codexKeychainService = "Codex Auth"
const codexTakeoverAPIKey = "gfa_codex_takeover"

var codexCredsMu sync.Mutex

func codexAuthPath() string { return filepath.Join(codexHomeDir(), "auth.json") }

func codexCredsBackupPath() string {
	return filepath.Join(codexHomeDir(), ".bcai-codex-creds-backup.json")
}

// codexCredsBackup 记录注入前 auth.json / macOS keychain 的状态(供精确还原)。
type codexCredsBackup struct {
	Injected         bool   `json:"injected"`
	Existed          bool   `json:"existed"`                    // 注入前文件是否存在
	Prev             []byte `json:"prev,omitempty"`             // 注入前的原始内容(Existed 时有效)
	KeychainCaptured bool   `json:"keychainCaptured,omitempty"` // 是否已捕获 macOS keychain 原状态
	KeychainExisted  bool   `json:"keychainExisted,omitempty"`
	PrevKeychain     string `json:"prevKeychain,omitempty"`
	// OAuth 投影写原始 JSON；API Key 模式按 Codex/Cockpit 约定不写 Keychain，
	// 而是暂时删除旧项，避免 Desktop 优先读到旧 OAuth 后停在登录页。
	KeychainProjection string `json:"keychainProjection,omitempty"` // "json" | "absent"
	ProjectionSHA256   string `json:"projectionSha256,omitempty"`   // 只还原 GFA 自己最后写入且未被外部替换的投影
}

// InjectFakeCodexAuth 写入远程接管专用登录投影。不信任磁盘上现有 token:
// 它可能 exp 未过但已被服务端 token_invalidated。远程接管必须像 Cockpit 切号一样
// 主动投影受控凭证。macOS 上 Codex 优先读 Keychain,所以必须与 auth.json 同步。
// 已注入(备份已存在)则只刷新伪凭证、不重复备份。
func InjectFakeCodexAuth() error {
	return projectCodexManagedAuth(buildFakeCodexAuth(), "旧伪 OAuth", true)
}

// InjectCodexAPIKeyAuth 对齐 Cockpit 的无账号 API 服务投影。它不是伪造 OAuth：
// Codex 看到的是正规的 apikey 登录形态，实际 key 只用于本机 bingchaai provider。
// 原 auth.json / macOS keychain 会被精确备份，取消接管时仅在投影未被外部替换的
// 前提下恢复，避免覆盖用户在接管期间主动登录或切换的新账号。
func InjectCodexAPIKeyAuth() error {
	projected, err := json.MarshalIndent(map[string]interface{}{
		"auth_mode":      "apikey",
		"OPENAI_API_KEY": codexTakeoverAPIKey,
	}, "", "  ")
	if err != nil {
		return err
	}
	return projectCodexManagedAuth(projected, "API Key", false)
}

func projectCodexManagedAuth(projected []byte, kind string, projectKeychain bool) error {
	codexCredsMu.Lock()
	defer codexCredsMu.Unlock()

	if err := os.MkdirAll(codexHomeDir(), 0o755); err != nil {
		return err
	}

	// 首次注入:备份原文件状态。已有备份说明处于接管态,不再覆盖备份。
	bk := readCodexCredsBackup()
	if bk == nil {
		bk = &codexCredsBackup{Injected: true}
		if data, err := os.ReadFile(codexAuthPath()); err == nil {
			bk.Existed = true
			bk.Prev = data
		}
	}
	// 兼容旧版备份:旧版只备份 auth.json,尚未动 keychain,可在首次升级注入时补捕获。
	if runtime.GOOS == "darwin" && !appActionsSuppressed() && !bk.KeychainCaptured {
		secret, existed, err := readCodexKeychainSecret()
		if err != nil {
			return err
		}
		// 13.7.6 曾把 GFA 的 API Key auth 误写进 Keychain。它不是用户原凭据，
		// 升级后不得再把这份坏状态当作备份恢复回去。
		if existed {
			_, legacyManagedOAuth := normalizeCodexKeychainOAuthSecret(secret)
			if isCodexManagedAPIKeyAuth(codexKeychainAuthBytes(secret)) || legacyManagedOAuth {
				secret = ""
				existed = false
			}
		}
		bk.KeychainCaptured = true
		bk.KeychainExisted = existed
		bk.PrevKeychain = secret
	}
	if runtime.GOOS == "darwin" && !appActionsSuppressed() {
		if projectKeychain {
			bk.KeychainProjection = "json"
		} else {
			bk.KeychainProjection = "absent"
		}
	}
	bk.ProjectionSHA256 = codexAuthProjectionDigest(projected)
	encodedBackup, err := json.MarshalIndent(bk, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(codexCredsBackupPath(), encodedBackup, 0o600); err != nil {
		return err
	}

	if err := writeFileAtomic(codexAuthPath(), projected, 0o600); err != nil {
		return err
	}
	// 对齐 Codex 官方存储与 Cockpit：
	//   OAuth/Agent Identity → Keychain 保存原始 JSON；
	//   API Key             → 不写 Keychain，只由 auth.json 承载。
	// Desktop 在 macOS 优先读 Keychain，向其中写 API Key 或 hex(JSON) 都可能
	// 让 auth.json 的有效 API Key 投影被旧/不可解析的 Keychain 状态遮蔽。
	if runtime.GOOS == "darwin" && !appActionsSuppressed() {
		if err := applyCodexManagedKeychainProjection(projected, projectKeychain, codexLocalKeychainOps{
			Write:  writeCodexKeychainSecret,
			Delete: deleteCodexKeychainSecret,
		}); err != nil {
			return err
		}
	}
	keychainProjected := runtime.GOOS == "darwin" && !appActionsSuppressed()
	Log("[codex-creds] 已投影远程接管 %s 登录态: auth=%s keychain=%v", kind, codexAuthPath(), keychainProjected)
	return nil
}

// RestoreFakeCodexAuth 还原被伪凭证覆盖的 auth.json。无备份(未注入过)则 no-op。
// 取消接管时调用。
func RestoreFakeCodexAuth() error {
	codexCredsMu.Lock()
	defer codexCredsMu.Unlock()

	bk := readCodexCredsBackup()
	if bk == nil {
		return nil // 未注入过,无需还原
	}
	currentAuth, _ := os.ReadFile(codexAuthPath())
	authWasProjected := codexManagedProjectionMatches(currentAuth, bk)
	if authWasProjected {
		if bk.Existed {
			if err := writeFileAtomic(codexAuthPath(), bk.Prev, 0o600); err != nil {
				return err
			}
		} else {
			// 原本没有 auth.json → 删除我们写的伪凭证。
			_ = os.Remove(codexAuthPath())
		}
	}
	keychainWasProjected := false
	if bk.KeychainCaptured {
		currentSecret, existed, err := readCodexKeychainSecret()
		if err != nil {
			return err
		}
		keychainWasProjected = codexManagedKeychainProjectionIsCurrent(currentSecret, existed, bk)
		if keychainWasProjected {
			if bk.KeychainExisted {
				if err := writeCodexKeychainSecret(bk.PrevKeychain); err != nil {
					return err
				}
			} else if err := deleteCodexKeychainSecret(); err != nil {
				return err
			}
		}
	}
	_ = os.Remove(codexCredsBackupPath())
	Log("[codex-creds] 已清理受管登录投影 (auth 已还原=%v keychain 已还原=%v)", authWasProjected, keychainWasProjected)
	return nil
}

func codexAuthProjectionDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func codexManagedProjectionMatches(data []byte, backup *codexCredsBackup) bool {
	if backup != nil && strings.TrimSpace(backup.ProjectionSHA256) != "" {
		return codexAuthProjectionDigest(data) == backup.ProjectionSHA256
	}
	// 兼容升级前没有 projectionSha256 的旧伪 OAuth 备份。
	return isFakeCodexAuth(data)
}

func codexManagedKeychainProjectionMatches(secret string, backup *codexCredsBackup) bool {
	raw := []byte(secret)
	if decoded, err := hex.DecodeString(secret); err == nil {
		raw = decoded
	}
	return codexManagedProjectionMatches(raw, backup)
}

func applyCodexManagedKeychainProjection(projected []byte, projectKeychain bool, ops codexLocalKeychainOps) error {
	if projectKeychain {
		return ops.Write(string(projected))
	}
	return ops.Delete()
}

func codexManagedKeychainProjectionIsCurrent(secret string, existed bool, backup *codexCredsBackup) bool {
	if backup == nil {
		return false
	}
	if backup.KeychainProjection == "absent" {
		return !existed
	}
	// "json" 以及 13.7.6 以前没有标记、写过 raw/hex(JSON) 的旧备份。
	return existed && codexManagedKeychainProjectionMatches(secret, backup)
}

// isFakeCodexAuth 只识别 GFA 自己生成的旧伪凭证。如果接管期间用户或
// Cockpit 已经写入一份新的真凭证,不得用旧备份把它覆盖回去。
func isFakeCodexAuth(data []byte) bool {
	var auth struct {
		Tokens struct {
			AccountID string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &auth) != nil {
		return false
	}
	return strings.HasPrefix(auth.Tokens.AccountID, "bcai-")
}

// isFakeCodexKeychainSecret 同时兼容旧 GFA 误写的 raw JSON 和 Codex 正确的
// hex(JSON) 存储形态。
func isFakeCodexKeychainSecret(secret string) bool {
	raw := []byte(secret)
	if decoded, err := hex.DecodeString(secret); err == nil {
		raw = decoded
	}
	return isFakeCodexAuth(raw)
}

// codexAuthHasOAuthIdentity 判断一份 Codex 登录快照是否足以保留 ChatGPT
// 账号能力（插件目录、workspace 插件、Apps/连接器等）。远程接管只借用这份
// 身份让 Codex 读取账号能力；生成请求仍由本地代理换成租来的号池 token。
func codexAuthHasOAuthIdentity(data []byte) bool {
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &auth) != nil {
		return false
	}
	if isCodexAPIKeyAuthMode(auth.AuthMode) {
		return false
	}
	if strings.HasPrefix(strings.TrimSpace(auth.Tokens.AccountID), "bcai-") {
		return false
	}
	return strings.TrimSpace(auth.Tokens.IDToken) != "" &&
		strings.TrimSpace(auth.Tokens.AccessToken) != "" &&
		strings.TrimSpace(auth.Tokens.RefreshToken) != ""
}

func isCodexAPIKeyAuthMode(mode string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", " ", "").
		Replace(strings.ToLower(strings.TrimSpace(mode)))
	return normalized == "apikey"
}

func isCodexManagedAPIKeyAuth(data []byte) bool {
	var auth struct {
		AuthMode string `json:"auth_mode"`
		APIKey   string `json:"OPENAI_API_KEY"`
	}
	return json.Unmarshal(data, &auth) == nil &&
		isCodexAPIKeyAuthMode(auth.AuthMode) &&
		strings.TrimSpace(auth.APIKey) == codexTakeoverAPIKey
}

func codexKeychainAuthBytes(secret string) []byte {
	if decoded, err := hex.DecodeString(strings.TrimSpace(secret)); err == nil {
		return decoded
	}
	return []byte(secret)
}

type codexOAuthStore uint8

const (
	codexOAuthStoreAuthFile codexOAuthStore = iota + 1
	codexOAuthStoreKeychain
)

type codexOAuthIdentity struct {
	IDToken      string
	AccessToken  string
	RefreshToken string
	AccountID    string
	Raw          []byte
	Store        codexOAuthStore
}

func parseCodexOAuthIdentity(data []byte, store ...codexOAuthStore) (codexOAuthIdentity, bool) {
	if !codexAuthHasOAuthIdentity(data) {
		return codexOAuthIdentity{}, false
	}
	var auth struct {
		Tokens struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &auth) != nil {
		return codexOAuthIdentity{}, false
	}
	accountID := strings.TrimSpace(auth.Tokens.AccountID)
	if accountID == "" {
		accountID = extractChatGPTAccountId(auth.Tokens.AccessToken)
	}
	selectedStore := codexOAuthStoreAuthFile
	if len(store) > 0 {
		selectedStore = store[0]
	}
	return codexOAuthIdentity{
		IDToken:      strings.TrimSpace(auth.Tokens.IDToken),
		AccessToken:  strings.TrimSpace(auth.Tokens.AccessToken),
		RefreshToken: strings.TrimSpace(auth.Tokens.RefreshToken),
		AccountID:    accountID,
		Raw:          append([]byte(nil), data...),
		Store:        selectedStore,
	}, true
}

func selectCodexOAuthIdentityForStore(authJSON, keychainJSON []byte, store string) (codexOAuthIdentity, bool) {
	switch strings.ToLower(strings.TrimSpace(store)) {
	case "keyring":
		return parseCodexOAuthIdentity(keychainJSON, codexOAuthStoreKeychain)
	case "auto":
		// 对齐 Codex AutoAuthStorage：Keychain 有一份可解析的凭据就以它为准；
		// 只有不存在或损坏时才回退 auth.json。Keychain 中的 API Key 也是一份
		// 有效非 OAuth 凭据，不能再借文件中的旧 OAuth。
		if len(keychainJSON) > 0 && json.Valid(keychainJSON) {
			return parseCodexOAuthIdentity(keychainJSON, codexOAuthStoreKeychain)
		}
		return parseCodexOAuthIdentity(authJSON, codexOAuthStoreAuthFile)
	case "ephemeral":
		return codexOAuthIdentity{}, false
	default: // 官方默认值是 file
		return parseCodexOAuthIdentity(authJSON, codexOAuthStoreAuthFile)
	}
}

func currentCodexAuthCredentialsStore() string {
	config, had, err := loadCodexConfig()
	if err != nil || !had {
		return "file"
	}
	store, _ := config[codexAuthCredentialsStore].(string)
	switch normalized := strings.ToLower(strings.TrimSpace(store)); normalized {
	case "file", "keyring", "auto", "ephemeral":
		return normalized
	default:
		return "file"
	}
}

// currentCodexOAuthIdentity 严格按 Codex 自己的 cli_auth_credentials_store
// 选择登录事实来源。不能因为运行在 macOS 就一律信 Keychain：官方默认是
// file，用户退出登录或切回 file 后钥匙串可能仍留有旧 OAuth；13.7.7 正是
// 因把这类残留误判为有效登录，跳过 API Key 投影后让客户停在登录页。
func currentCodexOAuthIdentity() (codexOAuthIdentity, bool) {
	authJSON, _ := os.ReadFile(codexAuthPath())
	var keychainJSON []byte
	store := currentCodexAuthCredentialsStore()
	if runtime.GOOS == "darwin" && (store == "keyring" || store == "auto") {
		secret, existed, err := readCodexKeychainSecret()
		if err != nil {
			Log("[codex] 读取 Keychain OAuth 失败，将按 %s 模式判定: %v", store, err)
		} else if existed {
			keychainJSON = codexKeychainAuthBytes(secret)
		}
	}
	return selectCodexOAuthIdentityForStore(authJSON, keychainJSON, store)
}

// detectCodexOAuthCapabilityBridge 只识别 Codex 当前已经保存的登录形态。
// 远程接管不是账号管理器：不得主动请求 usage 验号、不得消费轮换型 refresh token，
// 也不得因一次 401 就覆盖用户登录态。只要本地是完整 OAuth，就原样保留并让 Codex
// 自己负责续期；只有明确没有 OAuth（未登录/API Key）时才投影受管 API Key。
func detectCodexOAuthCapabilityBridge() (bool, string) {
	identity, ok := currentCodexOAuthIdentity()
	if !ok {
		return false, "未发现完整 OAuth 登录态"
	}
	store := "auth.json"
	if identity.Store == codexOAuthStoreKeychain {
		store = "macOS Keychain"
		// 13.7.6 曾按 hex(JSON) 写入本地接管 OAuth。Codex 官方与 Cockpit
		// 都只写原始 JSON，因此 hex 只能视为旧 GFA 受管残留，不能继续桥接。
		if secret, existed, err := readCodexKeychainSecret(); err == nil && existed {
			if _, legacyManaged := normalizeCodexKeychainOAuthSecret(secret); legacyManaged {
				return false, "检测到旧版 GFA Keychain OAuth 残留"
			}
		}
	}
	return true, "保留现有 OAuth 登录态（" + store + "，不验号、不刷新）"
}

func normalizeCodexKeychainOAuthSecret(secret string) (string, bool) {
	trimmed := strings.TrimSpace(secret)
	if json.Valid([]byte(trimmed)) {
		return secret, false
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil || !json.Valid(decoded) || !codexAuthHasOAuthIdentity(decoded) {
		return secret, false
	}
	return string(decoded), true
}

// codexKeychainAccount 对齐 Cockpit / Codex 官方键名:cli|sha256(canonical CODEX_HOME)[:16]。
func codexKeychainAccount() string {
	home := codexHomeDir()
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	} else if absolute, absErr := filepath.Abs(home); absErr == nil {
		home = absolute
	}
	digest := sha256.Sum256([]byte(home))
	return fmt.Sprintf("cli|%x", digest[:8])
}

func readCodexKeychainSecret() (string, bool, error) {
	if runtime.GOOS != "darwin" || appActionsSuppressed() {
		return "", false, nil
	}
	out, err := exec.Command("security", "find-generic-password", "-s", codexKeychainService, "-a", codexKeychainAccount(), "-w").CombinedOutput()
	if err == nil {
		return strings.TrimSuffix(strings.TrimSuffix(string(out), "\n"), "\r"), true, nil
	}
	lower := strings.ToLower(string(out))
	if strings.Contains(lower, "could not be found") || strings.Contains(lower, "item not found") {
		return "", false, nil
	}
	return "", false, fmt.Errorf("读取 Codex keychain 失败: %w: %s", err, strings.TrimSpace(string(out)))
}

func writeCodexKeychainSecret(secret string) error {
	if runtime.GOOS != "darwin" || appActionsSuppressed() {
		return nil
	}
	out, err := exec.Command("security", "add-generic-password", "-U", "-s", codexKeychainService, "-a", codexKeychainAccount(), "-w", secret).CombinedOutput()
	if err != nil {
		return fmt.Errorf("写入 Codex keychain 失败: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func deleteCodexKeychainSecret() error {
	if runtime.GOOS != "darwin" || appActionsSuppressed() {
		return nil
	}
	out, err := exec.Command("security", "delete-generic-password", "-s", codexKeychainService, "-a", codexKeychainAccount()).CombinedOutput()
	if err == nil {
		return nil
	}
	lower := strings.ToLower(string(out))
	if strings.Contains(lower, "could not be found") || strings.Contains(lower, "item not found") {
		return nil
	}
	return fmt.Errorf("删除 Codex keychain 失败: %w: %s", err, strings.TrimSpace(string(out)))
}

// codexHasExistingLogin 只判断 auth.json 在本地看起来是否有登录态。
// 它无法识别服务端 token_invalidated,因此仅供旧版迁移的诊断/回归测试;
// 新远程接管不再依赖任何 ChatGPT 登录态。
func codexHasExistingLogin() bool {
	data, err := os.ReadFile(codexAuthPath())
	if err != nil {
		return false
	}
	var a struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &a) != nil {
		return false
	}
	if a.Tokens.AccessToken == "" {
		return false
	}
	// 已过期的 access_token 视为「未登录」：否则接管时会因为"已登录"跳过伪凭证注入，GUI 启动
	// 读到这份废 token → 拿(往往同样失效的)refresh_token 去真 auth.openai.com 刷新 → 刷新失败
	// 就退回登录页(接管后"莫名要重新登录"的主因之一)。exp 解不出(opaque token / 非 JWT)时保守
	// 判已登录，不动用户真凭证 —— 交给 codex 自己的刷新流程。
	if exp, ok := codexJWTExp(a.Tokens.AccessToken); ok && exp <= time.Now().Unix() {
		return false
	}
	return true
}

// codexJWTExp 解出 JWT 的 exp(秒)。只取中段 payload base64url 解 JSON、不验签，与 codex 的
// decode_jwt_payload 同口径。非三段式 / 解不出 / 无 exp 时返回 ok=false。
func codexJWTExp(token string) (int64, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		if payload, err = base64.RawStdEncoding.DecodeString(parts[1]); err != nil {
			return 0, false
		}
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp == 0 {
		return 0, false
	}
	return int64(claims.Exp), true
}

func readCodexCredsBackup() *codexCredsBackup {
	data, err := os.ReadFile(codexCredsBackupPath())
	if err != nil {
		return nil
	}
	var bk codexCredsBackup
	if json.Unmarshal(data, &bk) != nil {
		return nil
	}
	return &bk
}

// buildFakeCodexAuth 生成伪 auth.json,结构对齐真实 Codex(auth_mode=chatgpt):
//
//	{ "auth_mode", "OPENAI_API_KEY":null, "tokens":{id_token,access_token,refresh_token,account_id}, "last_refresh" }
//
// id_token/access_token 是"签名乱码、payload 合法"的假 JWT,exp 设 1 年远(避免 stale 触发刷新)。
// 真 token 由 CodexProxy 转发时替换,故这里的值只需骗过 Codex 本地登录判定。
func buildFakeCodexAuth() []byte {
	exp := time.Now().Add(365 * 24 * time.Hour).Unix()
	accountID := "bcai-" + randToken(32)
	authClaim := map[string]interface{}{
		"chatgpt_plan_type":          "pro",
		"chatgpt_account_id":         accountID,
		"chatgpt_user_id":            "bcai-" + randToken(16),
		"chatgpt_account_is_fedramp": false,
	}
	idClaims := map[string]interface{}{
		"iss":                         "https://auth.openai.com",
		"aud":                         codexProviderID,
		"sub":                         accountID,
		"exp":                         exp,
		"email":                       codexFakeEmail,
		"https://api.openai.com/auth": authClaim,
	}
	accessClaims := map[string]interface{}{
		"iss":                         "https://auth.openai.com",
		"exp":                         exp,
		"https://api.openai.com/auth": authClaim,
	}
	auth := map[string]interface{}{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]interface{}{
			"id_token":      fakeCodexJWT(idClaims),
			"access_token":  fakeCodexJWT(accessClaims),
			"refresh_token": "bcai-fake-refresh-" + randToken(32),
			"account_id":    accountID,
		},
		"last_refresh": time.Now().UTC().Format("2006-01-02T15:04:05.000000Z"),
	}
	data, _ := json.MarshalIndent(auth, "", "  ")
	return data
}

// fakeCodexJWT 拼一个三段式 JWT:header.payload.signature。header/payload 是合法 base64url
// JSON,signature 段是固定乱码(绝非 OpenAI 私钥签的)。Codex 不验签,故能过本地解析;但对官方
// 无效 —— 这正是"本地能用、脱离代理就废"的关键。
func fakeCodexJWT(claims map[string]interface{}) string {
	enc := func(v interface{}) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	header := map[string]interface{}{"alg": "RS256", "typ": "JWT", "kid": "bcai-fake"}
	sig := base64.RawURLEncoding.EncodeToString([]byte("bcai-fake-signature-not-real"))
	return enc(header) + "." + enc(claims) + "." + sig
}

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
}

// InjectFakeCodexAuth 写入远程接管专用登录投影。不信任磁盘上现有 token:
// 它可能 exp 未过但已被服务端 token_invalidated。远程接管必须像 Cockpit 切号一样
// 主动投影受控凭证。macOS 上 Codex 优先读 Keychain,所以必须与 auth.json 同步。
// 已注入(备份已存在)则只刷新伪凭证、不重复备份。
func InjectFakeCodexAuth() error {
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
		bk.KeychainCaptured = true
		bk.KeychainExisted = existed
		bk.PrevKeychain = secret
	}
	encodedBackup, err := json.MarshalIndent(bk, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(codexCredsBackupPath(), encodedBackup, 0o600); err != nil {
		return err
	}

	fakeAuth := buildFakeCodexAuth()
	if err := writeFileAtomic(codexAuthPath(), fakeAuth, 0o600); err != nil {
		return err
	}
	// Codex/keyring 在 macOS generic-password 中保存的不是原始 JSON,
	// 而是 JSON bytes 的小写 hex 字符串。写原始 JSON 会被读成
	// auth_token_missing。虽然新远程接管已不再依赖伪登录,但保留
	// 正确编码以便旧版迁移/回归测试不再制造损坏的 keychain 项。
	if err := writeCodexKeychainSecret(hex.EncodeToString(fakeAuth)); err != nil {
		return err
	}
	keychainProjected := runtime.GOOS == "darwin" && !appActionsSuppressed()
	Log("[codex-creds] 已投影远程接管登录态: auth=%s keychain=%v", codexAuthPath(), keychainProjected)
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
	authWasProjected := isFakeCodexAuth(currentAuth)
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
		keychainWasProjected = existed && isFakeCodexKeychainSecret(currentSecret)
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
	Log("[codex-creds] 已清理旧登录投影 (auth 已还原=%v keychain 已还原=%v)", authWasProjected, keychainWasProjected)
	return nil
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

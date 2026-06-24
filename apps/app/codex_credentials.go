package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
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
// 为什么是安全的(脱离代理就废,崩溃/取消也白嫖不了):
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
// 备份/还原与幂等策略完全对齐 Claude 版:注入前把原 auth.json 状态(存在与否 + 原内容)备份到
// .bcai-codex-creds-backup.json;取消接管时精确还原;已注入则不重复备份(不把自己写的伪凭证
// 当成"用户原值")。

// codexFakeEmail 是伪登录态对外显示的占位邮箱(Codex 主界面"已登录为 xxx")。
const codexFakeEmail = "codex@bingchaai.app"

var codexCredsMu sync.Mutex

func codexAuthPath() string { return filepath.Join(codexHomeDir(), "auth.json") }

func codexCredsBackupPath() string {
	return filepath.Join(codexHomeDir(), ".bcai-codex-creds-backup.json")
}

// codexCredsBackup 记录注入前 auth.json 的状态(供精确还原)。
type codexCredsBackup struct {
	Injected bool   `json:"injected"`
	Existed  bool   `json:"existed"`        // 注入前文件是否存在
	Prev     []byte `json:"prev,omitempty"` // 注入前的原始内容(Existed 时有效)
}

// InjectFakeCodexAuth 写入伪 auth.json,让未登录的 Codex 以为已登录。由 codex 接管流程调用。
// 已注入(备份已存在)则只刷新伪凭证、不重复备份。
func InjectFakeCodexAuth() error {
	codexCredsMu.Lock()
	defer codexCredsMu.Unlock()

	if err := os.MkdirAll(codexHomeDir(), 0o755); err != nil {
		return err
	}

	// 首次注入:备份原文件状态(存在与否 + 原内容)。已有备份说明处于接管态,不再覆盖备份。
	if readCodexCredsBackup() == nil {
		bk := &codexCredsBackup{Injected: true}
		if data, err := os.ReadFile(codexAuthPath()); err == nil {
			bk.Existed = true
			bk.Prev = data
		}
		if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
			_ = writeFileAtomic(codexCredsBackupPath(), b, 0o600)
		}
	}

	if err := writeFileAtomic(codexAuthPath(), buildFakeCodexAuth(), 0o600); err != nil {
		return err
	}
	Log("[codex-creds] 已注入伪 auth.json: %s", codexAuthPath())
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
	if bk.Existed {
		if err := writeFileAtomic(codexAuthPath(), bk.Prev, 0o600); err != nil {
			return err
		}
	} else {
		// 原本没有 auth.json → 删除我们写的伪凭证。
		_ = os.Remove(codexAuthPath())
	}
	_ = os.Remove(codexCredsBackupPath())
	Log("[codex-creds] 已还原 auth.json (原本存在=%v)", bk.Existed)
	return nil
}

// codexHasExistingLogin 判断 ~/.codex/auth.json 是否已有登录态(tokens.access_token 非空)。
// 已有则接管时不覆盖 —— 保留用户真账号显示与真实刷新流程;仅完全未登录时才注入伪登录态。
// 不区分真假/是否过期:已有真 token 走 codex 自己的刷新,已有我们的伪 token(exp 远)本就有效。
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
	return a.Tokens.AccessToken != ""
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

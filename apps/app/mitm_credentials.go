package main

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ─── 伪 credentials.json 注入：对齐 reclaude cmd/inject ──────────────────────
//
// mock 登录默认开启时，桌面端接管(带代理重启 Claude)前往 ~/.claude/.credentials.json
// 写入一份伪 OAuth 凭证，让 Code/Cowork 子进程(Claude Code CLI)以为已登录——不弹登录
// 直接发 /v1/messages，由 MITM 接管换号池 token。文件里的 token 仅用于"骗过登录判定"，
// 真正打上游的 token 由 ClaudeProxy 在转发时替换，故其值无所谓。
//
// 备份/还原：注入前把原文件状态(存在与否 + 原内容)备份到 .bcai-claude-creds-backup.json；
// 取消接管时精确还原(原本没有就删除我们写的文件，原本有就写回原内容)。幂等：已注入则
// 不重复备份，避免把自己写的伪凭证当成"用户原值"备份掉。
//
// 平台说明：Windows/Linux 上 Claude Code 直接读 .credentials.json，注入即生效；macOS 上
// Claude Code 默认优先用 Keychain 存登录态，本文件可能被忽略——纯文件注入在 mac 上能否
// 让"完全未登录"的客户端可用需真机验证(必要时再补 `security add-generic-password`)。
// 另：本文件只覆盖 Code/Cowork 子进程读取的 CLI 凭证；Desktop 聊天 UI 的登录态经
// host-auth(IPC) 下发，不在覆盖范围内。

var claudeCredsMu sync.Mutex

func claudeCredentialsPath() string {
	return filepath.Join(claudeConfigDir(), ".credentials.json")
}

func claudeCredentialsBackupPath() string {
	return filepath.Join(claudeConfigDir(), ".bcai-claude-creds-backup.json")
}

// claudeCredsBackup 记录注入前 .credentials.json 的状态(供精确还原)。
type claudeCredsBackup struct {
	Injected bool   `json:"injected"`
	Existed  bool   `json:"existed"`         // 注入前文件是否存在
	Prev     []byte `json:"prev,omitempty"`  // 注入前的原始内容(Existed 时有效)
}

// InjectFakeClaudeCredentials 写入伪 OAuth 凭证，让 Code/Cowork 以为已登录。
// 仅在 mock 登录开启时由接管流程调用。已注入(备份已存在)则只刷新伪凭证、不重复备份。
func InjectFakeClaudeCredentials() error {
	claudeCredsMu.Lock()
	defer claudeCredsMu.Unlock()

	if err := os.MkdirAll(claudeConfigDir(), 0o700); err != nil {
		return err
	}

	// 首次注入：备份原文件状态(存在与否 + 原内容)。已有备份说明处于接管态，不再覆盖备份。
	if readClaudeCredsBackup() == nil {
		bk := &claudeCredsBackup{Injected: true}
		if data, err := os.ReadFile(claudeCredentialsPath()); err == nil {
			bk.Existed = true
			bk.Prev = data
		}
		if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
			_ = writeFileAtomic(claudeCredentialsBackupPath(), b, 0o600)
		}
	}

	if err := writeFileAtomic(claudeCredentialsPath(), buildFakeClaudeCredentials(), 0o600); err != nil {
		return err
	}
	// 顺带预置 onboarding，避免接管后 Code/Cowork 首次运行弹引导(与 settings 注入同款)。
	ensureClaudeOnboardingComplete()
	Log("[mitm-creds] 已注入伪 credentials.json: %s", claudeCredentialsPath())
	return nil
}

// RestoreFakeClaudeCredentials 还原被伪凭证覆盖的 .credentials.json。
// 无备份(未注入过)则 no-op。取消接管时调用，无条件尝试(与 mock 开关无关)。
func RestoreFakeClaudeCredentials() error {
	claudeCredsMu.Lock()
	defer claudeCredsMu.Unlock()

	bk := readClaudeCredsBackup()
	if bk == nil {
		return nil // 未注入过，无需还原
	}
	if bk.Existed {
		if err := writeFileAtomic(claudeCredentialsPath(), bk.Prev, 0o600); err != nil {
			return err
		}
	} else {
		// 原本没有凭证文件 → 删除我们写的伪凭证。
		_ = os.Remove(claudeCredentialsPath())
	}
	_ = os.Remove(claudeCredentialsBackupPath())
	Log("[mitm-creds] 已还原 credentials.json (原本存在=%v)", bk.Existed)
	return nil
}

func readClaudeCredsBackup() *claudeCredsBackup {
	data, err := os.ReadFile(claudeCredentialsBackupPath())
	if err != nil {
		return nil
	}
	var bk claudeCredsBackup
	if json.Unmarshal(data, &bk) != nil {
		return nil
	}
	return &bk
}

// buildFakeClaudeCredentials 生成伪 OAuth 凭证，结构对齐真实 Claude Code .credentials.json:
//
//	{ "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt", "scopes", "subscriptionType" } }
//
// token 仅需格式合法以骗过登录判定(真 token 由 ClaudeProxy 转发时替换)；expiresAt 设远期
// 避免客户端因"已过期"触发刷新流程。
func buildFakeClaudeCredentials() []byte {
	creds := map[string]interface{}{
		"claudeAiOauth": map[string]interface{}{
			"accessToken":      "sk-ant-oat01-" + randToken(43),
			"refreshToken":     "sk-ant-ort01-" + randToken(43),
			"expiresAt":        time.Now().Add(365 * 24 * time.Hour).UnixMilli(),
			"scopes":           []string{"user:inference", "user:profile"},
			"subscriptionType": "pro",
		},
	}
	data, _ := json.MarshalIndent(creds, "", "  ")
	return data
}

// randToken 生成 n 位 base64url 字符(对齐 reclaude SK 格式 ^[A-Za-z0-9_-]+$)。
func randToken(n int) string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败极罕见；退化为定长占位，不影响"已登录"判定。
		for i := range b {
			b[i] = charset[i%len(charset)]
		}
		return string(b)
	}
	for i := range b {
		b[i] = charset[int(b[i])%len(charset)]
	}
	return string(b)
}

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 把 claude 配置目录隔离到临时目录，避免测试污染真实 ~/.claude。
func isolateClaudeDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	return dir
}

func readFakeCredsOAuth(t *testing.T) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(claudeCredentialsPath())
	if err != nil {
		t.Fatalf("读取伪凭证失败: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("伪凭证非合法 JSON: %v", err)
	}
	oauth, ok := m["claudeAiOauth"].(map[string]interface{})
	if !ok {
		t.Fatalf("伪凭证缺少 claudeAiOauth 字段: %v", m)
	}
	return oauth
}

// 原本没有凭证文件 → 注入写入伪凭证；还原后该文件被删除、备份也清理。
func TestFakeCreds_InjectRestore_NoPriorFile(t *testing.T) {
	isolateClaudeDir(t)

	if err := InjectFakeClaudeCredentials(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	oauth := readFakeCredsOAuth(t)
	if oauth["accessToken"] == "" || oauth["subscriptionType"] != "pro" {
		t.Fatalf("伪凭证内容不符合预期: %v", oauth)
	}
	if _, err := os.Stat(claudeCredentialsBackupPath()); err != nil {
		t.Fatalf("应已写备份文件: %v", err)
	}

	if err := RestoreFakeClaudeCredentials(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	if _, err := os.Stat(claudeCredentialsPath()); !os.IsNotExist(err) {
		t.Fatalf("原本无文件，还原后应删除伪凭证，err=%v", err)
	}
	if _, err := os.Stat(claudeCredentialsBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("还原后应清理备份文件，err=%v", err)
	}
}

// 原本存在真凭证 → 注入覆盖、还原后原内容被精确写回。
func TestFakeCreds_InjectRestore_PreservesExisting(t *testing.T) {
	dir := isolateClaudeDir(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"claudeAiOauth":{"accessToken":"REAL-USER-TOKEN"}}`)
	if err := os.WriteFile(claudeCredentialsPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InjectFakeClaudeCredentials(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	// 注入后应是伪凭证(token 不再是真值)。
	if oauth := readFakeCredsOAuth(t); oauth["accessToken"] == "REAL-USER-TOKEN" {
		t.Fatalf("注入后仍是用户原 token，未覆盖")
	}

	if err := RestoreFakeClaudeCredentials(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	got, err := os.ReadFile(claudeCredentialsPath())
	if err != nil {
		t.Fatalf("还原后应保留文件: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("还原内容不一致:\n want %s\n got  %s", original, got)
	}
}

// 重复注入应幂等：不把自己写的伪凭证当成"用户原值"备份掉，还原后仍能回到真实原值。
func TestFakeCreds_InjectIdempotent(t *testing.T) {
	dir := isolateClaudeDir(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"claudeAiOauth":{"accessToken":"REAL-USER-TOKEN"}}`)
	if err := os.WriteFile(claudeCredentialsPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InjectFakeClaudeCredentials(); err != nil {
		t.Fatalf("首次注入失败: %v", err)
	}
	if err := InjectFakeClaudeCredentials(); err != nil {
		t.Fatalf("二次注入失败: %v", err)
	}

	// 备份里应仍是用户真实原值，而非第一次注入的伪凭证。
	bk := readClaudeCredsBackup()
	if bk == nil || !bk.Existed {
		t.Fatalf("备份应记录原文件存在: %v", bk)
	}
	if string(bk.Prev) != string(original) {
		t.Fatalf("二次注入污染了备份:\n want %s\n got  %s", original, bk.Prev)
	}

	if err := RestoreFakeClaudeCredentials(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	got, _ := os.ReadFile(claudeCredentialsPath())
	if string(got) != string(original) {
		t.Fatalf("幂等注入后还原内容不一致:\n want %s\n got %s", original, got)
	}
}

// 未注入过直接还原应为 no-op（不报错、不创建文件）。
func TestFakeCreds_RestoreWithoutInject_NoOp(t *testing.T) {
	isolateClaudeDir(t)
	if err := RestoreFakeClaudeCredentials(); err != nil {
		t.Fatalf("无备份时还原应 no-op，却报错: %v", err)
	}
	if _, err := os.Stat(claudeCredentialsPath()); !os.IsNotExist(err) {
		t.Fatalf("无备份还原不应创建凭证文件")
	}
}

// 防回归：备份文件名固定在 claude 配置目录下。
func TestFakeCreds_BackupPathUnderConfigDir(t *testing.T) {
	dir := isolateClaudeDir(t)
	if filepath.Dir(claudeCredentialsBackupPath()) != dir {
		t.Fatalf("备份路径应在配置目录下: %s", claudeCredentialsBackupPath())
	}
}

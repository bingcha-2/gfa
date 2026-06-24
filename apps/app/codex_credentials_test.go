package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 把 CODEX_HOME 隔离到临时目录，避免测试污染真实 ~/.codex。
func isolateCodexHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	return dir
}

func readFakeCodexAuth(t *testing.T) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatalf("读取伪 auth.json 失败: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("伪 auth.json 非合法 JSON: %v", err)
	}
	return m
}

// decodeJWTPayload 复刻 codex 的 decode_jwt_payload：只取中段 base64url 解 JSON，不验签。
func decodeJWTPayload(t *testing.T, jwt string) map[string]interface{} {
	t.Helper()
	parts := splitDots(jwt)
	if len(parts) != 3 {
		t.Fatalf("JWT 不是三段式: %q", jwt)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("JWT payload base64 解码失败: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("JWT payload 非合法 JSON: %v", err)
	}
	return m
}

func splitDots(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == '.' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(c)
	}
	return append(out, cur)
}

// 伪 auth.json 的核心约定：auth_mode=chatgpt，id_token 可解出 email，exp 在远未来（不触发刷新）。
func TestFakeCodexAuth_Structure(t *testing.T) {
	isolateCodexHome(t)
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	m := readFakeCodexAuth(t)
	if m["auth_mode"] != "chatgpt" {
		t.Fatalf("auth_mode 应为 chatgpt, got %v", m["auth_mode"])
	}
	tokens, ok := m["tokens"].(map[string]interface{})
	if !ok {
		t.Fatalf("缺少 tokens 字段: %v", m)
	}
	idTok, _ := tokens["id_token"].(string)
	if idTok == "" {
		t.Fatalf("缺少 id_token")
	}
	payload := decodeJWTPayload(t, idTok)
	if payload["email"] != codexFakeEmail {
		t.Fatalf("id_token email 不符: %v", payload["email"])
	}
	expF, ok := payload["exp"].(float64)
	if !ok {
		t.Fatalf("id_token 缺少 exp")
	}
	// exp 必须在远未来（至少 300 天后），否则 codex 会判 stale 触发刷新。
	if int64(expF) < time.Now().Add(300*24*time.Hour).Unix() {
		t.Fatalf("exp 设得不够远，可能触发刷新: exp=%d now=%d", int64(expF), time.Now().Unix())
	}
}

// 防白嫖核心：注入的 token 必须是"乱码签名"，绝不能是任何真实可用凭证。
func TestFakeCodexAuth_SignatureIsFake(t *testing.T) {
	isolateCodexHome(t)
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	tokens := readFakeCodexAuth(t)["tokens"].(map[string]interface{})
	for _, k := range []string{"id_token", "access_token"} {
		jwt := tokens[k].(string)
		parts := splitDots(jwt)
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		if string(sig) != "bcai-fake-signature-not-real" {
			t.Fatalf("%s 签名段不是预期的乱码占位: %q", k, sig)
		}
	}
}

// 原本没有 auth.json → 注入写入；还原后该文件被删除、备份也清理。
func TestFakeCodexAuth_InjectRestore_NoPriorFile(t *testing.T) {
	isolateCodexHome(t)
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	if _, err := os.Stat(codexCredsBackupPath()); err != nil {
		t.Fatalf("应已写备份文件: %v", err)
	}
	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	if _, err := os.Stat(codexAuthPath()); !os.IsNotExist(err) {
		t.Fatalf("原本无文件，还原后应删除伪 auth.json，err=%v", err)
	}
	if _, err := os.Stat(codexCredsBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("还原后应清理备份文件，err=%v", err)
	}
}

// 原本存在真 auth.json → 注入覆盖、还原后原内容被精确写回。
func TestFakeCodexAuth_PreservesExisting(t *testing.T) {
	dir := isolateCodexHome(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"REAL-USER-TOKEN"}}`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("注入失败: %v", err)
	}
	tokens := readFakeCodexAuth(t)["tokens"].(map[string]interface{})
	if tokens["access_token"] == "REAL-USER-TOKEN" {
		t.Fatalf("注入后仍是用户原 token，未覆盖")
	}

	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	got, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatalf("还原后应保留文件: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("还原内容不一致:\n want %s\n got  %s", original, got)
	}
}

// 重复注入应幂等：不把自己写的伪凭证当成"用户原值"备份掉，还原后仍能回到真实原值。
func TestFakeCodexAuth_InjectIdempotent(t *testing.T) {
	dir := isolateCodexHome(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"REAL-USER-TOKEN"}}`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("首次注入失败: %v", err)
	}
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("二次注入失败: %v", err)
	}

	bk := readCodexCredsBackup()
	if bk == nil || !bk.Existed {
		t.Fatalf("备份应记录原文件存在: %v", bk)
	}
	if string(bk.Prev) != string(original) {
		t.Fatalf("二次注入污染了备份:\n want %s\n got  %s", original, bk.Prev)
	}

	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	got, _ := os.ReadFile(codexAuthPath())
	if string(got) != string(original) {
		t.Fatalf("幂等注入后还原内容不一致:\n want %s\n got %s", original, got)
	}
}

// 未注入过直接还原应为 no-op（不报错、不创建文件）。
func TestFakeCodexAuth_RestoreWithoutInject_NoOp(t *testing.T) {
	isolateCodexHome(t)
	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("无备份时还原应 no-op，却报错: %v", err)
	}
	if _, err := os.Stat(codexAuthPath()); !os.IsNotExist(err) {
		t.Fatalf("无备份还原不应创建 auth.json")
	}
}

// codexHasExistingLogin：无文件→false；有 access_token→true；注入伪 auth 后→true。
func TestCodexHasExistingLogin(t *testing.T) {
	dir := isolateCodexHome(t)
	if codexHasExistingLogin() {
		t.Fatalf("无 auth.json 时应判未登录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 无 tokens 字段 → 未登录。
	if err := os.WriteFile(codexAuthPath(), []byte(`{"auth_mode":"chatgpt"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if codexHasExistingLogin() {
		t.Fatalf("缺 access_token 时应判未登录")
	}
	// 有 access_token → 已登录。
	if err := os.WriteFile(codexAuthPath(), []byte(`{"tokens":{"access_token":"x"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !codexHasExistingLogin() {
		t.Fatalf("有 access_token 时应判已登录")
	}
	// 注入伪 auth 后也应判已登录(伪 token 有 access_token)。
	isolateCodexHome(t)
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatal(err)
	}
	if !codexHasExistingLogin() {
		t.Fatalf("注入伪 auth 后应判已登录")
	}
}

// 防回归：备份文件名固定在 CODEX_HOME 目录下，且不与 model_provider 备份(.bcai-codex-backup.json)同名。
func TestFakeCodexAuth_BackupPathDistinct(t *testing.T) {
	dir := isolateCodexHome(t)
	if filepath.Dir(codexCredsBackupPath()) != dir {
		t.Fatalf("备份路径应在 CODEX_HOME 下: %s", codexCredsBackupPath())
	}
	if codexCredsBackupPath() == codexBackupPath() {
		t.Fatalf("凭证备份不应与 model_provider 备份同名: %s", codexCredsBackupPath())
	}
}

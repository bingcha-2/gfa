package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
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

func testCodexJWTWithExp(t *testing.T, exp int64) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload, err := json.Marshal(map[string]interface{}{"exp": exp})
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
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

func TestCodexAPIKeyAuthProjectionMatchesCockpitAndRestoresOriginal(t *testing.T) {
	dir := isolateCodexHome(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"USER-TOKEN"}}`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InjectCodexAPIKeyAuth(); err != nil {
		t.Fatalf("API Key 投影失败: %v", err)
	}
	projected, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatal(err)
	}
	var auth map[string]interface{}
	if err := json.Unmarshal(projected, &auth); err != nil {
		t.Fatal(err)
	}
	if auth["auth_mode"] != "apikey" || auth["OPENAI_API_KEY"] != codexTakeoverAPIKey {
		t.Fatalf("无账号投影未对齐 Cockpit API Key 形态: %#v", auth)
	}
	backup := readCodexCredsBackup()
	if backup == nil || backup.ProjectionSHA256 != codexAuthProjectionDigest(projected) {
		t.Fatalf("投影摘要未持久化: %+v", backup)
	}

	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	restored, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatalf("用户原 auth 未精确恢复:\nwant %s\ngot  %s", original, restored)
	}
}

func TestRestoreCodexAPIKeyAuthDoesNotClobberLoginDuringTakeover(t *testing.T) {
	isolateCodexHome(t)
	if err := InjectCodexAPIKeyAuth(); err != nil {
		t.Fatal(err)
	}
	replacement := []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"NEW-LOGIN","account_id":"real"}}`)
	if err := os.WriteFile(codexAuthPath(), replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(replacement) {
		t.Fatalf("接管期间的新登录被旧备份覆盖:\nwant %s\ngot  %s", replacement, got)
	}
}

// 旧远程接管期间若用户已切到一份新的本地真号,迁移时只丢弃
// 过期备份,不能用较早的登录态把用户新选的号覆盖掉。
func TestRestoreFakeCodexAuth_DoesNotClobberExternallyReplacedAuth(t *testing.T) {
	isolateCodexHome(t)
	original := []byte(`{"tokens":{"access_token":"ORIGINAL"}}`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatal(err)
	}
	replacement := []byte(`{"tokens":{"access_token":"NEW-LOCAL-ACCOUNT","account_id":"real-account"}}`)
	if err := os.WriteFile(codexAuthPath(), replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(replacement) {
		t.Fatalf("外部新凭证被旧备份覆盖:\nwant %s\ngot  %s", replacement, got)
	}
	if _, err := os.Stat(codexCredsBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("迁移后应删除过期备份, err=%v", err)
	}
}

func TestIsFakeCodexKeychainSecretSupportsLegacyRawAndCodexHex(t *testing.T) {
	fake := buildFakeCodexAuth()
	if !isFakeCodexKeychainSecret(string(fake)) {
		t.Fatal("应识别旧版误写的 raw JSON 伪凭证")
	}
	if !isFakeCodexKeychainSecret(hex.EncodeToString(fake)) {
		t.Fatal("应识别 Codex keyring 的 hex(JSON) 伪凭证")
	}
	if isFakeCodexKeychainSecret(hex.EncodeToString([]byte(`{"tokens":{"account_id":"real-account"}}`))) {
		t.Fatal("不应把真账号 keychain 误判为 GFA 伪凭证")
	}
}

func TestCodexAuthHasOAuthIdentity(t *testing.T) {
	realOAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh","account_id":"account-1"}}`)
	if !codexAuthHasOAuthIdentity(realOAuth) {
		t.Fatal("完整真实 OAuth 应被识别")
	}
	if !codexAuthHasOAuthIdentity(codexKeychainAuthBytes(hex.EncodeToString(realOAuth))) {
		t.Fatal("Keychain 的 hex(JSON) OAuth 应被识别")
	}
	for name, raw := range map[string][]byte{
		"api key": []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}`),
		"api key with stale oauth": []byte(
			`{"auth_mode":"api_key","OPENAI_API_KEY":"sk-test","tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh","account_id":"account-1"}}`,
		),
		"missing refresh": []byte(`{"tokens":{"id_token":"id","access_token":"access","account_id":"account-1"}}`),
		"legacy fake":     buildFakeCodexAuth(),
	} {
		t.Run(name, func(t *testing.T) {
			if codexAuthHasOAuthIdentity(raw) {
				t.Fatalf("%s 不应被识别为可保留账号能力的 OAuth", name)
			}
		})
	}
}

func TestSelectCodexOAuthIdentityMatchesCockpitPrecedence(t *testing.T) {
	fileOAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"file-id","access_token":"file-access","refresh_token":"file-refresh","account_id":"file-account"}}`)
	keychainOAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"key-id","access_token":"key-access","refresh_token":"key-refresh","account_id":"key-account"}}`)

	identity, ok := selectCodexOAuthIdentity(fileOAuth, keychainOAuth, true)
	if !ok || identity.Store != codexOAuthStoreKeychain || identity.AccessToken != "key-access" {
		t.Fatalf("macOS 应优先 Keychain: ok=%v identity=%+v", ok, identity)
	}
	identity, ok = selectCodexOAuthIdentity(fileOAuth, keychainOAuth, false)
	if !ok || identity.Store != codexOAuthStoreAuthFile || identity.AccessToken != "file-access" {
		t.Fatalf("非 macOS 应使用 auth.json: ok=%v identity=%+v", ok, identity)
	}
	apiKeyMode := []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}`)
	if identity, ok = selectCodexOAuthIdentity(apiKeyMode, keychainOAuth, true); ok {
		t.Fatalf("显式 API Key 模式不得借用残留 Keychain OAuth: %+v", identity)
	}
}

func TestCodexHasOAuthIdentityReadsAuthFile(t *testing.T) {
	isolateCodexHome(t)
	oauth := []byte(`{"tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh","account_id":"account-1"}}`)
	if err := os.WriteFile(codexAuthPath(), oauth, 0o600); err != nil {
		t.Fatal(err)
	}
	identity, ok := currentCodexOAuthIdentity()
	if !ok {
		t.Fatal("auth.json 中的真实 OAuth 应被识别")
	}
	if identity.AccessToken != "access" || identity.AccountID != "account-1" {
		t.Fatalf("OAuth identity 解析错误: %+v", identity)
	}
}

func TestDetectCodexOAuthCapabilityBridgePreservesCompleteLoginWithoutMutation(t *testing.T) {
	isolateCodexHome(t)
	oauth := []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh","account_id":"account-1"},"custom":"preserved"}`)
	if err := os.WriteFile(codexAuthPath(), oauth, 0o600); err != nil {
		t.Fatal(err)
	}
	if ok, reason := detectCodexOAuthCapabilityBridge(); !ok {
		t.Fatalf("完整 OAuth 应直接桥接: %s", reason)
	}
	got, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, oauth) {
		t.Fatalf("识别 OAuth 时不得改写用户凭证:\nwant %s\ngot  %s", oauth, got)
	}
}

func TestDetectCodexOAuthCapabilityBridgeRejectsOnlyNonOAuthShape(t *testing.T) {
	isolateCodexHome(t)
	if err := os.WriteFile(codexAuthPath(), []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if ok, reason := detectCodexOAuthCapabilityBridge(); ok || reason == "" {
		t.Fatalf("API Key 形态不得当成 OAuth: ok=%v reason=%q", ok, reason)
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

// 过期的真登录残留必须判「未登录」：否则接管时因"已登录"跳过伪凭证注入，GUI 启动拿这份废
// token 去真 auth.openai.com 刷新→失败→退回登录页(接管后"莫名要登录"主因之一)。
func TestCodexHasExistingLogin_ExpiredAccessToken(t *testing.T) {
	dir := isolateCodexHome(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// exp 已过 → 未登录。
	writeCodexAuthAccessToken(t, fakeCodexJWT(map[string]interface{}{"exp": time.Now().Add(-time.Hour).Unix()}))
	if codexHasExistingLogin() {
		t.Fatalf("access_token 已过期,应判未登录")
	}
	// exp 在未来 → 已登录。
	writeCodexAuthAccessToken(t, fakeCodexJWT(map[string]interface{}{"exp": time.Now().Add(48 * time.Hour).Unix()}))
	if !codexHasExistingLogin() {
		t.Fatalf("access_token 未过期,应判已登录")
	}
	// 不透明(非 JWT)token 解不出 exp → 保守判已登录,不动用户真凭证,交给 codex 自身刷新。
	writeCodexAuthAccessToken(t, "opaque-non-jwt-token")
	if !codexHasExistingLogin() {
		t.Fatalf("opaque token 解不出 exp 时应保守判已登录")
	}
}

// 旧版投影器的回归:不能因为旧 token 的 exp 在未来就保留它,
// 因为服务端可能已 token_invalidated。新远程接管不再调用该投影器。
func TestFakeCodexAuth_OverwritesUnexpiredExistingLogin(t *testing.T) {
	isolateCodexHome(t)
	originalToken := fakeCodexJWT(map[string]interface{}{"exp": time.Now().Add(48 * time.Hour).Unix()})
	writeCodexAuthAccessToken(t, originalToken)
	if !codexHasExistingLogin() {
		t.Fatal("预置 token 本地应看起来未过期")
	}

	if err := InjectFakeCodexAuth(); err != nil {
		t.Fatalf("远程接管投影失败: %v", err)
	}
	projected := readFakeCodexAuth(t)["tokens"].(map[string]interface{})["access_token"].(string)
	if projected == originalToken {
		t.Fatal("未过期旧 token 未被受管登录投影覆盖")
	}

	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatalf("还原失败: %v", err)
	}
	var restored struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	raw, err := os.ReadFile(codexAuthPath())
	if err != nil {
		t.Fatalf("读取还原 auth.json 失败: %v", err)
	}
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatalf("解析还原 auth.json 失败: %v", err)
	}
	if restored.Tokens.AccessToken != originalToken {
		t.Fatal("退出接管后未精确还原用户原 token")
	}
}

func writeCodexAuthAccessToken(t *testing.T, accessToken string) {
	t.Helper()
	data, _ := json.MarshalIndent(map[string]interface{}{
		"auth_mode": "chatgpt",
		"tokens":    map[string]interface{}{"access_token": accessToken},
	}, "", "  ")
	if err := os.WriteFile(codexAuthPath(), data, 0o600); err != nil {
		t.Fatal(err)
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

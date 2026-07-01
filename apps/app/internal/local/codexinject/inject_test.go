package codexinject

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readAuth(t *testing.T, home string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func TestInject_OAuth(t *testing.T) {
	home := t.TempDir()
	if err := InjectToHome(home, Token{AuthKind: "oauth", IDToken: "id", AccessToken: "at", RefreshToken: "rt", AccountID: "acc"}); err != nil {
		t.Fatalf("InjectToHome: %v", err)
	}
	m := readAuth(t, home)
	if v, ok := m["OPENAI_API_KEY"]; !ok || v != nil {
		t.Fatalf("OAuth 应写 OPENAI_API_KEY=null, got %v (present=%v)", v, ok)
	}
	toks, _ := m["tokens"].(map[string]any)
	if toks["access_token"] != "at" || toks["id_token"] != "id" || toks["refresh_token"] != "rt" || toks["account_id"] != "acc" {
		t.Fatalf("tokens wrong: %+v", toks)
	}
	if lr, _ := m["last_refresh"].(string); lr == "" {
		t.Fatal("last_refresh 应写当下时间")
	}
}

func TestInject_APIKey(t *testing.T) {
	home := t.TempDir()
	if err := InjectToHome(home, Token{AuthKind: "apikey", APIKey: "sk-x"}); err != nil {
		t.Fatalf("InjectToHome: %v", err)
	}
	m := readAuth(t, home)
	if m["auth_mode"] != "apikey" || m["OPENAI_API_KEY"] != "sk-x" {
		t.Fatalf("apikey auth.json wrong: %+v", m)
	}
	if _, ok := m["tokens"]; ok {
		t.Fatal("apikey 不应有 tokens")
	}
}

func TestInject_OAuthMissingAccessTokenErrors(t *testing.T) {
	home := t.TempDir()
	if err := InjectToHome(home, Token{AuthKind: "oauth", IDToken: "id"}); err == nil {
		t.Fatal("缺 access_token 应报错")
	}
}

func TestRestore_BringsBackOriginal(t *testing.T) {
	home := t.TempDir()
	authPath := filepath.Join(home, "auth.json")
	orig := []byte(`{"OPENAI_API_KEY":"sk-original"}`)
	if err := os.WriteFile(authPath, orig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InjectToHome(home, Token{AuthKind: "oauth", AccessToken: "at", AccountID: "a"}); err != nil {
		t.Fatalf("inject: %v", err)
	}
	// 注入后已变。
	if m := readAuth(t, home); m["OPENAI_API_KEY"] != nil {
		t.Fatalf("注入后应为 OAuth 形态, got %+v", m)
	}
	if err := RestoreHome(home); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if m := readAuth(t, home); m["OPENAI_API_KEY"] != "sk-original" {
		t.Fatalf("还原应恢复原 auth.json, got %+v", m)
	}
}

func TestRestore_NoBackupRemovesInjected(t *testing.T) {
	home := t.TempDir()
	if err := InjectToHome(home, Token{AuthKind: "oauth", AccessToken: "at", AccountID: "a"}); err != nil {
		t.Fatalf("inject: %v", err)
	}
	if err := RestoreHome(home); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("无备份时还原应删除注入的 auth.json")
	}
}

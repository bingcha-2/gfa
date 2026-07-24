package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"bcai-wails/internal/local/codexinject"
)

func TestCodexLocalRemoteHandoffKeepsSelectedLoginOnRemoteCancel(t *testing.T) {
	home := isolateCodexHome(t)
	original := []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"original"}}`)
	if err := os.WriteFile(filepath.Join(home, "auth.json"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := codexinject.InjectToHome(home, codexinject.Token{
		AuthKind: "oauth", IDToken: "id", AccessToken: "selected",
		RefreshToken: "refresh", AccountID: "account",
	}); err != nil {
		t.Fatal(err)
	}
	if err := markCodexLocalRemoteHandoff(); err != nil {
		t.Fatal(err)
	}
	if err := commitCodexLocalAccountProjection(); err != nil {
		t.Fatal(err)
	}
	finishCodexLocalRemoteHandoff()
	got, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) == string(original) || !containsJSONToken(got, "selected") {
		t.Fatalf("取消远程后应保持选中的自有号登录:\noriginal %s\ngot      %s", original, got)
	}
	if _, err := os.Stat(codexLocalRemoteHandoffPath()); !os.IsNotExist(err) {
		t.Fatalf("handoff marker 应清理, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".bcai-codex-auth-backup.json")); !os.IsNotExist(err) {
		t.Fatalf("本地登录备份应在 handoff 时提交并清理, err=%v", err)
	}
}

func TestCodexLocalRemoteHandoffKeepsSelectedLoginWhenOriginallyLoggedOut(t *testing.T) {
	home := isolateCodexHome(t)
	if err := codexinject.InjectToHome(home, codexinject.Token{
		AuthKind: "oauth", IDToken: "id", AccessToken: "selected",
		RefreshToken: "refresh", AccountID: "account",
	}); err != nil {
		t.Fatal(err)
	}
	if err := markCodexLocalRemoteHandoff(); err != nil {
		t.Fatal(err)
	}
	if err := commitCodexLocalAccountProjection(); err != nil {
		t.Fatal(err)
	}
	finishCodexLocalRemoteHandoff()
	got, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !containsJSONToken(got, "selected") {
		t.Fatalf("原本未登录也应保持当前自有号登录: %s", got)
	}
}

func containsJSONToken(data []byte, token string) bool {
	return string(data) != "" && string(data) != "{}" &&
		len(token) > 0 && bytes.Contains(data, []byte(token))
}

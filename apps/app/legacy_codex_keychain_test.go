package main

import (
	"encoding/json"
	"os"
	"testing"
)

type fakeCodexKeychain struct {
	secret  string
	existed bool
}

func (f *fakeCodexKeychain) ops() codexLocalKeychainOps {
	return codexLocalKeychainOps{
		Read: func() (string, bool, error) {
			return f.secret, f.existed, nil
		},
		Write: func(secret string) error {
			f.secret = secret
			f.existed = true
			return nil
		},
		Delete: func() error {
			f.secret = ""
			f.existed = false
			return nil
		},
	}
}

func TestLocalCodexOAuthProjectionWritesRawJSONKeychainAndRestoresOriginal(t *testing.T) {
	isolateCodexHome(t)
	keychain := &fakeCodexKeychain{secret: "original-keychain", existed: true}
	auth := []byte(`{"OPENAI_API_KEY":null,"tokens":{"id_token":"id","access_token":"at","refresh_token":"rt","account_id":"acc"}}`)

	if err := projectCodexLocalAccountKeychainWithOps(auth, keychain.ops()); err != nil {
		t.Fatal(err)
	}
	if want := string(auth); keychain.secret != want {
		t.Fatalf("keychain projection=%q want=%q", keychain.secret, want)
	}
	if _, err := os.Stat(codexLocalKeychainBackupPath()); err != nil {
		t.Fatalf("missing local keychain backup: %v", err)
	}

	if err := restoreCodexLocalAccountKeychainWithOps(keychain.ops()); err != nil {
		t.Fatal(err)
	}
	if !keychain.existed || keychain.secret != "original-keychain" {
		t.Fatalf("original keychain not restored: %+v", keychain)
	}
}

func TestLocalCodexOAuthProjectionDeletesKeychainWhenOriginallyAbsent(t *testing.T) {
	isolateCodexHome(t)
	keychain := &fakeCodexKeychain{}
	auth := []byte(`{"OPENAI_API_KEY":null,"tokens":{"id_token":"id","access_token":"at","account_id":"acc"}}`)

	if err := projectCodexLocalAccountKeychainWithOps(auth, keychain.ops()); err != nil {
		t.Fatal(err)
	}
	if err := restoreCodexLocalAccountKeychainWithOps(keychain.ops()); err != nil {
		t.Fatal(err)
	}
	if keychain.existed {
		t.Fatalf("projected keychain should be removed: %+v", keychain)
	}
}

func TestLocalCodexOAuthRestorePreservesExternalLogin(t *testing.T) {
	isolateCodexHome(t)
	keychain := &fakeCodexKeychain{secret: "original-keychain", existed: true}
	auth := []byte(`{"OPENAI_API_KEY":null,"tokens":{"id_token":"id","access_token":"at","account_id":"acc"}}`)

	if err := projectCodexLocalAccountKeychainWithOps(auth, keychain.ops()); err != nil {
		t.Fatal(err)
	}
	keychain.secret = `{"tokens":{"id_token":"new","access_token":"new","account_id":"new-account"}}`
	if err := restoreCodexLocalAccountKeychainWithOps(keychain.ops()); err != nil {
		t.Fatal(err)
	}
	if decoded := string(codexKeychainAuthBytes(keychain.secret)); decoded == "original-keychain" {
		t.Fatal("external login was overwritten by stale backup")
	}
	if _, err := os.Stat(codexLocalKeychainBackupPath()); !os.IsNotExist(err) {
		t.Fatalf("stale backup should be removed, err=%v", err)
	}
}

// Fixture for projections made by retired releases; production only restores.
func projectCodexLocalAccountKeychainWithOps(authJSON []byte, ops codexLocalKeychainOps) error {
	backupPath := codexLocalKeychainBackupPath()
	var backup codexLocalKeychainBackup
	if data, err := os.ReadFile(backupPath); err == nil {
		if err := json.Unmarshal(data, &backup); err != nil {
			return err
		}
	} else if os.IsNotExist(err) {
		secret, existed, readErr := ops.Read()
		if readErr != nil {
			return readErr
		}
		backup.Existed = existed
		backup.Prev = secret
	} else {
		return err
	}

	backup.ProjectionSHA256 = codexAuthProjectionDigest(authJSON)
	encoded, err := json.MarshalIndent(backup, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(backupPath, encoded, 0o600); err != nil {
		return err
	}
	// Codex 官方 Keychain 与 Cockpit 都保存原始 auth JSON。旧版 GFA 写成
	// hex(JSON)，Desktop 会把它当成不可解析凭据并停在登录页。
	return ops.Write(string(authJSON))
}

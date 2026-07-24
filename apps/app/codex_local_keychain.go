package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const codexLocalKeychainBackupFile = ".bcai-codex-local-keychain-backup.json"

type codexLocalKeychainBackup struct {
	Existed          bool   `json:"existed"`
	Prev             string `json:"prev,omitempty"`
	ProjectionSHA256 string `json:"projectionSha256"`
}

type codexLocalKeychainOps struct {
	Read   func() (string, bool, error)
	Write  func(string) error
	Delete func() error
}

func codexLocalKeychainBackupPath() string {
	return filepath.Join(codexHomeDir(), codexLocalKeychainBackupFile)
}

func projectCodexLocalAccountKeychain(authJSON []byte) error {
	if runtime.GOOS != "darwin" || appActionsSuppressed() {
		return nil
	}
	return projectCodexLocalAccountKeychainWithOps(authJSON, codexLocalKeychainOps{
		Read:   readCodexKeychainSecret,
		Write:  writeCodexKeychainSecret,
		Delete: deleteCodexKeychainSecret,
	})
}

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

func restoreCodexLocalAccountKeychain() error {
	if runtime.GOOS != "darwin" || appActionsSuppressed() {
		return nil
	}
	return restoreCodexLocalAccountKeychainWithOps(codexLocalKeychainOps{
		Read:   readCodexKeychainSecret,
		Write:  writeCodexKeychainSecret,
		Delete: deleteCodexKeychainSecret,
	})
}

func restoreCodexLocalAccountKeychainWithOps(ops codexLocalKeychainOps) error {
	backupPath := codexLocalKeychainBackupPath()
	data, err := os.ReadFile(backupPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var backup codexLocalKeychainBackup
	if err := json.Unmarshal(data, &backup); err != nil {
		return err
	}

	current, existed, err := ops.Read()
	if err != nil {
		return err
	}
	currentJSON := codexKeychainAuthBytes(current)
	projected := existed &&
		strings.TrimSpace(backup.ProjectionSHA256) != "" &&
		codexAuthProjectionDigest(currentJSON) == backup.ProjectionSHA256
	if projected {
		if backup.Existed {
			if err := ops.Write(backup.Prev); err != nil {
				return err
			}
		} else if err := ops.Delete(); err != nil {
			return err
		}
	}
	return os.Remove(backupPath)
}

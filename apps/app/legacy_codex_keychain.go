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

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Identifier retained only to remove retired provider settings.
const codexLocalProviderID = "gfa_local_provider"

// Restore-only support for users upgrading from the retired self-owned account
// feature. The saved account database remains on disk; it is never opened here.
func restoreLegacyCodexAccount() error {
	backup := filepath.Join(codexHomeDir(), ".bcai-codex-auth-backup.json")
	data, err := os.ReadFile(backup)
	if err == nil {
		if err = writeFileAtomic(codexAuthPath(), data, 0600); err != nil {
			return err
		}
		if err = restoreCodexLocalAccountKeychain(); err != nil {
			return err
		}
		return os.Remove(backup)
	}
	if !os.IsNotExist(err) {
		return err
	}
	return restoreCodexLocalAccountKeychain()
}

func restoreCodexLocalSourceBeforeRemote() (bool, error) {
	path := filepath.Join(getAppDataDir(), "local", "sources.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var sources map[string]string
	if err = json.Unmarshal(data, &sources); err != nil {
		return false, err
	}
	if sources["codex"] != "local" {
		return false, nil
	}
	backup := filepath.Join(codexHomeDir(), ".bcai-codex-auth-backup.json")
	if _, err = os.Stat(backup); os.IsNotExist(err) {
		// Older versions had no backup when auth.json did not originally exist.
		// Preserve the retired projection rather than deleting potentially edited credentials.
		dest := codexAuthPath() + ".retired-local-" + time.Now().Format("20060102-150405.000000000")
		if err = os.Rename(codexAuthPath(), dest); err != nil && !os.IsNotExist(err) {
			return false, err
		}
	} else if err != nil {
		return false, err
	}
	if err = restoreLegacyCodexAccount(); err != nil {
		return false, err
	}
	sources["codex"] = "remote"
	if err = writeDesktopJSON(path, sources); err != nil {
		return false, err
	}
	return true, nil
}

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const codexAuthRepairBackupPrefix = "auth.json.bingchaai-backup-"

var codexAuthRepairMu sync.Mutex

// RepairCodexAuth removes a user-owned auth.json from Codex's active home,
// keeping a timestamped backup so the action is recoverable. Credentials
// projected by BingchaAI are restored through the existing managed restore
// paths instead of being treated as user data.
//
// The returned value is one of: removed, restored-managed, or missing. A
// removed result returns the backup path instead, so the UI can show it.
func (a *App) RepairCodexAuth() (string, error) {
	codexAuthRepairMu.Lock()
	defer codexAuthRepairMu.Unlock()

	authPath := codexAuthPath()
	managedBackup := readCodexCredsBackup()
	managedBackupPath := codexCredsBackupPath()
	if _, statErr := os.Stat(managedBackupPath); statErr == nil && managedBackup == nil {
		return "", fmt.Errorf("BingchaAI 的 Codex 凭证备份无法解析，未修改 auth.json")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return "", fmt.Errorf("inspect managed Codex credential backup: %w", statErr)
	}
	localBackupPath := filepath.Join(codexHomeDir(), ".bcai-codex-auth-backup.json")
	_, localBackupErr := os.Stat(localBackupPath)
	if localBackupErr != nil && !os.IsNotExist(localBackupErr) {
		return "", fmt.Errorf("inspect local Codex credential backup: %w", localBackupErr)
	}

	info, statErr := os.Lstat(authPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			if localBackupErr == nil {
				if err := (localPlatform{}).CodexRestoreAccount(); err != nil {
					return "", fmt.Errorf("restore managed Codex credentials: %w", err)
				}
				Log("[codex-auth-repair] restored managed local credentials after auth.json was missing")
				return "restored-managed", nil
			}
			return "missing", nil
		}
		return "", fmt.Errorf("inspect Codex auth.json: %w", statErr)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Codex auth.json is a symbolic link; it was not changed")
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("Codex auth.json is not a regular file; it was not changed")
	}

	data, err := os.ReadFile(authPath)
	if err != nil {
		return "", fmt.Errorf("read Codex auth.json: %w", err)
	}

	if managedBackup != nil && codexManagedProjectionMatches(data, managedBackup) {
		if err := RestoreFakeCodexAuth(); err != nil {
			return "", fmt.Errorf("restore managed Codex credentials: %w", err)
		}
		Log("[codex-auth-repair] restored managed remote credentials instead of deleting auth.json")
		return "restored-managed", nil
	}
	if localBackupErr == nil {
		if err := (localPlatform{}).CodexRestoreAccount(); err != nil {
			return "", fmt.Errorf("restore managed Codex account: %w", err)
		}
		Log("[codex-auth-repair] restored managed local account instead of deleting auth.json")
		return "restored-managed", nil
	}

	// Serialize the final move with the managed credential projection path.
	// If a takeover starts between the earlier inspection and this lock, leave
	// the file untouched and let the user retry after the state settles.
	codexCredsMu.Lock()
	defer codexCredsMu.Unlock()
	latest, latestErr := os.ReadFile(authPath)
	if latestErr != nil {
		return "", fmt.Errorf("recheck Codex auth.json: %w", latestErr)
	}
	if latestManaged := readCodexCredsBackup(); latestManaged != nil && codexManagedProjectionMatches(latest, latestManaged) {
		return "", fmt.Errorf("Codex takeover became active while repairing; please retry after it finishes")
	}
	backupPath := filepath.Join(codexHomeDir(), fmt.Sprintf("%s%s.json", codexAuthRepairBackupPrefix, time.Now().Format("20060102-150405.000000000")))
	if err := os.Rename(authPath, backupPath); err != nil {
		return "", fmt.Errorf("move Codex auth.json to backup: %w", err)
	}
	Log("[codex-auth-repair] moved user auth.json to %s", backupPath)
	if runtime.GOOS == "darwin" {
		return "removed-keychain-present:" + backupPath, nil
	}
	return backupPath, nil
}

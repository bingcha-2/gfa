package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var claudeCredsMu sync.Mutex

// Read-only migration support for credentials backed up by older releases.
type claudeCredsBackup struct {
	Injected bool   `json:"injected"`
	Existed  bool   `json:"existed"`
	Prev     []byte `json:"prev,omitempty"`
}

func claudeCredentialsPath() string {
	return filepath.Join(claudeConfigDir(), ".credentials.json")
}

func claudeCredentialsBackupPath() string {
	return filepath.Join(claudeConfigDir(), ".bcai-claude-creds-backup.json")
}

func RestoreFakeClaudeCredentials() error {
	claudeCredsMu.Lock()
	defer claudeCredsMu.Unlock()

	data, err := os.ReadFile(claudeCredentialsBackupPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var bk claudeCredsBackup
	if json.Unmarshal(data, &bk) != nil || !bk.Injected {
		return fmt.Errorf("旧 Claude 凭证备份损坏，停止恢复")
	}
	if bk.Existed {
		if err := writeFileAtomic(claudeCredentialsPath(), bk.Prev, 0o600); err != nil {
			return err
		}
	} else {
		// 原本没有凭证文件 → 删除我们写的伪凭证。
		if err := os.Remove(claudeCredentialsPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Remove(claudeCredentialsBackupPath()); err != nil {
		return err
	}
	Log("[mitm-creds] 已还原 credentials.json (原本存在=%v)", bk.Existed)
	return nil
}

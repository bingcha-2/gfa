package main

import (
	"encoding/json"
	"fmt"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func restoreLegacyHostEnvironment() error {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	snap, err := readHostProtectionSnapshot()
	if err != nil || snap == nil {
		return err
	}
	if snap.BrowserPreferencesChanged {
		hostProtectionStopDesktopForPreferences()
	}
	restored := restoreHostChromiumProfiles(snap)
	if restored < len(snap.BrowserProfiles) {
		return fmt.Errorf("旧浏览器配置尚未完全恢复，备份已保留")
	}
	if _, err = restoreHostBrowserPreferences(snap); err != nil {
		return err
	}
	if err = hostProtectionRestore(snap.OriginalSystemTimezone, snap.TimezoneChanged); err != nil {
		return err
	}
	if err = restoreLegacyClaudeTimezone(snap.AppliedTimezone); err != nil {
		return err
	}
	return removeHostProtectionSnapshot()
}

func restoreLegacyClaudeTimezone(applied string) error {
	if applied == "" {
		return nil
	}
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()
	doc, exists, err := readDesktopJSON(claudeSettingsPath())
	if err != nil || !exists {
		return err
	}
	env, _ := doc["env"].(map[string]interface{})
	if env[claudeTimezoneKey] != applied {
		return nil
	}
	delete(env, claudeTimezoneKey)
	if backup := readClaudeBackup(); backup != nil && backup.OriginalCaptured {
		var original map[string]interface{}
		if json.Unmarshal([]byte(backup.Original), &original) == nil {
			oldEnv, _ := original["env"].(map[string]interface{})
			if value, ok := oldEnv[claudeTimezoneKey]; ok {
				env[claudeTimezoneKey] = value
			}
		}
	}
	return writeClaudeSettings(doc)
}

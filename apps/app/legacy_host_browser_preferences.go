package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Legacy restore support only. New settings and sandbox creation are removed.
type hostPreferenceBackup struct {
	Present bool            `json:"present"`
	Value   json.RawMessage `json:"value,omitempty"`
}

var (
	hostGeolocationPreferencePath = []string{"profile", "default_content_setting_values", "geolocation"}
	hostWebRTCPreferencePath      = []string{"webrtc", "ip_handling_policy"}
)

func readHostPreferenceDocument(path string) (map[string]interface{}, bool, os.FileMode, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]interface{}{}, false, 0o600, nil
	}
	if err != nil {
		return nil, false, 0, err
	}
	root := map[string]interface{}{}
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, true, 0, fmt.Errorf("Claude Preferences 不是有效 JSON: %w", err)
	}
	perm := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		perm = info.Mode().Perm()
	}
	return root, true, perm, nil
}

func setHostNestedPreference(root map[string]interface{}, path []string, value interface{}) {
	current := root
	for _, key := range path[:len(path)-1] {
		next, ok := current[key].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			current[key] = next
		}
		current = next
	}
	current[path[len(path)-1]] = value
}

func deleteHostNestedPreference(root map[string]interface{}, path []string) {
	var walk func(map[string]interface{}, int) bool
	walk = func(current map[string]interface{}, index int) bool {
		key := path[index]
		if index == len(path)-1 {
			delete(current, key)
			return len(current) == 0
		}
		next, ok := current[key].(map[string]interface{})
		if !ok {
			return len(current) == 0
		}
		if walk(next, index+1) {
			delete(current, key)
		}
		return len(current) == 0
	}
	if len(path) > 0 {
		walk(root, 0)
	}
}

func restoreHostPreference(root map[string]interface{}, path []string, backup hostPreferenceBackup) error {
	if !backup.Present {
		deleteHostNestedPreference(root, path)
		return nil
	}
	var value interface{}
	if err := json.Unmarshal(backup.Value, &value); err != nil {
		return err
	}
	setHostNestedPreference(root, path, value)
	return nil
}

func writeHostPreferenceDocument(path string, root map[string]interface{}, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(root)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, perm)
}

type browserRestoreOutcome struct {
	Skipped     bool // 未接管过浏览器策略(无该文件),无需还原
	WebRTC      bool // 已还原 WebRTC ip_handling_policy
	Geolocation bool // 已还原地理位置 content-setting
	FileRemoved bool // 接管前本就无此文件 → 删除整份 Preferences
}

func restoreHostBrowserPreferences(snap *hostProtectionSnapshot) (browserRestoreOutcome, error) {
	if !snap.BrowserPreferencesChanged || snap.BrowserPreferencesPath == "" {
		return browserRestoreOutcome{Skipped: true}, nil
	}
	root, exists, perm, err := readHostPreferenceDocument(snap.BrowserPreferencesPath)
	if err != nil {
		return browserRestoreOutcome{}, err
	}
	if !exists && !snap.BrowserPreferencesHadFile {
		return browserRestoreOutcome{Skipped: true}, nil
	}
	if snap.BrowserPreferencesPerm != 0 {
		perm = os.FileMode(snap.BrowserPreferencesPerm)
	}
	out := browserRestoreOutcome{}
	if snap.BlockWebRTC {
		if err := restoreHostPreference(root, hostWebRTCPreferencePath, snap.WebRTCPreference); err != nil {
			return browserRestoreOutcome{}, err
		}
		out.WebRTC = true
	}
	if snap.BlockGeolocation {
		if err := restoreHostPreference(root, hostGeolocationPreferencePath, snap.GeolocationPreference); err != nil {
			return browserRestoreOutcome{}, err
		}
		out.Geolocation = true
	}
	if len(root) == 0 && !snap.BrowserPreferencesHadFile {
		err := os.Remove(snap.BrowserPreferencesPath)
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		if err != nil {
			return browserRestoreOutcome{}, err
		}
		out.FileRemoved = true
		return out, nil
	}
	if err := writeHostPreferenceDocument(snap.BrowserPreferencesPath, root, perm); err != nil {
		return browserRestoreOutcome{}, err
	}
	return out, nil
}

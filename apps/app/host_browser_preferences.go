package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

type hostPreferenceBackup struct {
	Present bool            `json:"present"`
	Value   json.RawMessage `json:"value,omitempty"`
}

var (
	hostGeolocationPreferencePath = []string{"profile", "default_content_setting_values", "geolocation"}
	hostWebRTCPreferencePath      = []string{"webrtc", "ip_handling_policy"}
)

func hostClaudePreferencesPath() string {
	// 单测永远落临时 config dir，不读取开发机真实 Claude profile。
	if origConfigDir != "" {
		return filepath.Join(origConfigDir, "test-claude-preferences.json")
	}
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "Claude", "Preferences")
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base, _ = os.UserConfigDir()
		}
		return filepath.Join(base, "Claude", "Preferences")
	default:
		return ""
	}
}

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

func getHostNestedPreference(root map[string]interface{}, path []string) (interface{}, bool) {
	var current interface{} = root
	for _, key := range path {
		m, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		current, ok = m[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
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

func captureHostPreference(root map[string]interface{}, path []string) (hostPreferenceBackup, error) {
	value, present := getHostNestedPreference(root, path)
	if !present {
		return hostPreferenceBackup{}, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return hostPreferenceBackup{}, err
	}
	return hostPreferenceBackup{Present: true, Value: raw}, nil
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

func captureHostBrowserPreferences(snap *hostProtectionSnapshot) error {
	path := hostClaudePreferencesPath()
	if path == "" || !containsHostTarget(snap.Targets, "claude_desktop") || (!snap.BlockWebRTC && !snap.BlockGeolocation) {
		return nil
	}
	root, hadFile, perm, err := readHostPreferenceDocument(path)
	if err != nil {
		return err
	}
	snap.BrowserPreferencesPath = path
	snap.BrowserPreferencesHadFile = hadFile
	snap.BrowserPreferencesPerm = uint32(perm)
	snap.BrowserPreferencesChanged = true
	if snap.BlockWebRTC {
		snap.WebRTCPreference, err = captureHostPreference(root, hostWebRTCPreferencePath)
		if err != nil {
			return err
		}
	}
	if snap.BlockGeolocation {
		snap.GeolocationPreference, err = captureHostPreference(root, hostGeolocationPreferencePath)
	}
	return err
}

func applyHostBrowserPreferences(snap *hostProtectionSnapshot) error {
	if !snap.BrowserPreferencesChanged || snap.BrowserPreferencesPath == "" {
		return nil
	}
	root, _, perm, err := readHostPreferenceDocument(snap.BrowserPreferencesPath)
	if err != nil {
		return err
	}
	if snap.BrowserPreferencesPerm != 0 {
		perm = os.FileMode(snap.BrowserPreferencesPerm)
	}
	if snap.BlockWebRTC {
		setHostNestedPreference(root, hostWebRTCPreferencePath, "disable_non_proxied_udp")
	}
	if snap.BlockGeolocation {
		// Chromium CONTENT_SETTING_BLOCK。
		setHostNestedPreference(root, hostGeolocationPreferencePath, 2)
	}
	return writeHostPreferenceDocument(snap.BrowserPreferencesPath, root, perm)
}

// browserRestoreOutcome 概述还原 Claude 浏览器策略时实际做了什么,供还原日志逐项汇报,
// 补齐旧版「已完整还原」只报时区、不报浏览器策略/文件去向的盲区。
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

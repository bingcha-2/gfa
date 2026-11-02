package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Legacy restore support only. New settings and sandbox creation are removed.
type hostProtectionSnapshot struct {
	Version                   int                    `json:"version"`
	State                     string                 `json:"state"` // applying | active | restoring
	OwnerPID                  int                    `json:"ownerPid"`
	CreatedAt                 string                 `json:"createdAt"`
	OriginalSystemTimezone    string                 `json:"originalSystemTimezone"`
	OriginalDisplayTimezone   string                 `json:"originalDisplayTimezone"`
	ExitTimezone              string                 `json:"exitTimezone"`
	AppliedSystemTimezone     string                 `json:"appliedSystemTimezone"`
	AppliedTimezone           string                 `json:"appliedTimezone"`
	TimezoneStrategy          string                 `json:"timezoneStrategy"`
	TimezoneChanged           bool                   `json:"timezoneChanged"`
	BlockWebRTC               bool                   `json:"blockWebRTC"`
	BlockGeolocation          bool                   `json:"blockGeolocation"`
	DNSCleared                bool                   `json:"dnsCleared"`
	Targets                   []string               `json:"targets"`
	LastError                 string                 `json:"lastError,omitempty"`
	BrowserPreferencesPath    string                 `json:"browserPreferencesPath,omitempty"`
	BrowserPreferencesHadFile bool                   `json:"browserPreferencesHadFile"`
	BrowserPreferencesPerm    uint32                 `json:"browserPreferencesPerm,omitempty"`
	BrowserPreferencesChanged bool                   `json:"browserPreferencesChanged"`
	WebRTCPreference          hostPreferenceBackup   `json:"webRTCPreference"`
	GeolocationPreference     hostPreferenceBackup   `json:"geolocationPreference"`
	BrowserProfiles           []browserProfileBackup `json:"browserProfiles,omitempty"` // 机器级真实浏览器防封的逐 profile 备份
}

const hostProtectionSnapshotVersion = 2

var hostProtectionMu sync.Mutex

func hostProtectionSnapshotPath() string {
	return filepath.Join(getAppDataDir(), "host-protection.json")
}

func readHostProtectionSnapshot() (*hostProtectionSnapshot, error) {
	data, err := os.ReadFile(hostProtectionSnapshotPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap hostProtectionSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("解析宿主防护快照失败: %w", err)
	}
	if snap.Version != hostProtectionSnapshotVersion {
		return nil, fmt.Errorf("不支持的宿主防护快照版本: %d", snap.Version)
	}
	return &snap, nil
}

func removeHostProtectionSnapshot() error {
	err := os.Remove(hostProtectionSnapshotPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

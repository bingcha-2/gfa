//go:build windows

package main

import (
	"fmt"
	"strings"
)

type hostProtectionApplyResult struct {
	AppliedSystemTimezone string
	DNSCleared            bool
}

func hostProtectionPlatform() string { return "windows" }

func hostProtectionRequiresAuthorization(bool) bool { return false }

func hostProtectionStopDesktopForPreferences() {
	if !appActionsSuppressed() {
		mitmKillClaudeWindows()
	}
}

func hostProtectionReadTimezone() (string, string, error) {
	out, err := hideCmd("tzutil", "/g").CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("tzutil /g: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	display := windowsIDToCanonicalIANA(id)
	if display == "" {
		display = id
	}
	return id, display, nil
}

func hostProtectionApply(timezone string, changeTimezone, flushDNS bool) (hostProtectionApplyResult, error) {
	result := hostProtectionApplyResult{}
	if changeTimezone {
		id, ok := ianaToWindowsTimezoneID(timezone)
		if !ok {
			return result, fmt.Errorf("Windows 暂无 IANA 时区映射: %s", timezone)
		}
		if !appActionsSuppressed() {
			out, err := hideCmd("tzutil", "/s", id).CombinedOutput()
			if err != nil {
				return result, fmt.Errorf("设置 Windows 时区失败: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		}
		result.AppliedSystemTimezone = id
	}
	if flushDNS {
		if appActionsSuppressed() {
			result.DNSCleared = true
		} else if out, err := hideCmd("ipconfig", "/flushdns").CombinedOutput(); err != nil {
			Log("[host-protection] Windows DNS 缓存清理失败(不阻塞接管): %v (%s)", err, strings.TrimSpace(string(out)))
		} else {
			result.DNSCleared = true
		}
	}
	return result, nil
}

func hostProtectionRestore(originalSystemTimezone string, timezoneChanged bool) error {
	if !timezoneChanged || strings.TrimSpace(originalSystemTimezone) == "" || appActionsSuppressed() {
		return nil
	}
	out, err := hideCmd("tzutil", "/s", originalSystemTimezone).CombinedOutput()
	if err != nil {
		return fmt.Errorf("恢复 Windows 时区失败: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

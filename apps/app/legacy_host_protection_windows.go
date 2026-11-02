//go:build windows

package main

import (
	"fmt"
	"strings"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func hostProtectionStopDesktopForPreferences() {
	if !appActionsSuppressed() {
		stopClaudeDesktop()
	}
}

func killProcessByName(name string) {
	_ = hideCmd("taskkill", "/F", "/IM", name).Run()
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

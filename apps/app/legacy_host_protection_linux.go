//go:build linux

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func hostProtectionStopDesktopForPreferences() {}

func killProcessByName(name string) {
	_ = exec.Command("pkill", "-x", name).Run()
}

func runPrivilegedLinux(name string, args ...string) error {
	if _, err := exec.LookPath("pkexec"); err == nil {
		full := append([]string{name}, args...)
		return exec.Command("pkexec", full...).Run()
	}
	return exec.Command(name, args...).Run()
}

func hostProtectionRestore(originalSystemTimezone string, timezoneChanged bool) error {
	if !timezoneChanged || strings.TrimSpace(originalSystemTimezone) == "" || appActionsSuppressed() {
		return nil
	}
	if err := runPrivilegedLinux("timedatectl", "set-timezone", originalSystemTimezone); err != nil {
		return fmt.Errorf("恢复 Linux 时区失败: %w", err)
	}
	return nil
}

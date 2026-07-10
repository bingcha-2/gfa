//go:build !darwin && !windows && !linux

package main

import (
	"errors"
	"os/exec"
	"time"
)

type hostProtectionApplyResult struct {
	AppliedSystemTimezone string
	DNSCleared            bool
}

func hostProtectionPlatform() string { return "unsupported" }

func hostProtectionRequiresAuthorization(bool) bool { return false }

func hostProtectionStopDesktopForPreferences() {}

// killProcessByName 结束指定进程(浏览器防封改 prefs 前先关浏览器)。调用方已过 appActionsSuppressed。
func killProcessByName(name string) {
	_ = exec.Command("pkill", "-x", name).Run()
}

func hostProtectionReadTimezone() (string, string, error) {
	tz := time.Now().Location().String()
	return tz, tz, nil
}

func hostProtectionApply(timezone string, changeTimezone, flushDNS bool) (hostProtectionApplyResult, error) {
	if appActionsSuppressed() {
		return hostProtectionApplyResult{AppliedSystemTimezone: timezone, DNSCleared: flushDNS}, nil
	}
	if changeTimezone {
		return hostProtectionApplyResult{}, errors.New("宿主防护仅支持 Windows 与 macOS")
	}
	return hostProtectionApplyResult{}, nil
}

func hostProtectionRestore(string, bool) error { return nil }

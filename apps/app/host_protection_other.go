//go:build !darwin && !windows

package main

import (
	"errors"
	"time"
)

type hostProtectionApplyResult struct {
	AppliedSystemTimezone string
	DNSCleared            bool
}

func hostProtectionPlatform() string { return "unsupported" }

func hostProtectionRequiresAuthorization(bool) bool { return false }

func hostProtectionStopDesktopForPreferences() {}

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

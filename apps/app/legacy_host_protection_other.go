//go:build !darwin && !windows && !linux

package main

import (
	"os/exec"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func hostProtectionStopDesktopForPreferences() {}

func killProcessByName(name string) {
	_ = exec.Command("pkill", "-x", name).Run()
}

func hostProtectionRestore(string, bool) error { return nil }

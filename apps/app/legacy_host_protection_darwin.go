//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func hostProtectionStopDesktopForPreferences() {
	if !appActionsSuppressed() {
		stopClaudeDesktop()
	}
}

func killProcessByName(name string) {
	_ = exec.Command("/usr/bin/pkill", "-x", name).Run()
}

func appleScriptEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

func hostProtectionRestore(originalSystemTimezone string, timezoneChanged bool) error {
	if !timezoneChanged || strings.TrimSpace(originalSystemTimezone) == "" {
		return nil
	}
	if appActionsSuppressed() {
		return nil
	}
	command := "/usr/sbin/systemsetup -settimezone " + shellQuote(originalSystemTimezone) + " >/dev/null"
	script := fmt.Sprintf(`do shell script "%s" with administrator privileges`, appleScriptEscape(command))
	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("恢复系统时区失败: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

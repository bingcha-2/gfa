//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

type hostProtectionApplyResult struct {
	AppliedSystemTimezone string
	DNSCleared            bool
}

func hostProtectionPlatform() string { return "macos" }

func hostProtectionRequiresAuthorization(timezoneChanged bool) bool { return timezoneChanged }

func hostProtectionStopDesktopForPreferences() {
	if !appActionsSuppressed() {
		mitmQuitClaude()
	}
}

// killProcessByName 结束指定进程(浏览器防封改 prefs 前先关浏览器)。调用方已过 appActionsSuppressed。
// pkill -x 精确匹配进程名,避免误伤含子串的其它进程。
func killProcessByName(name string) {
	_ = exec.Command("/usr/bin/pkill", "-x", name).Run()
}

func hostProtectionReadTimezone() (string, string, error) {
	if out, err := exec.Command("/usr/bin/readlink", "/etc/localtime").Output(); err == nil {
		path := strings.TrimSpace(string(out))
		if i := strings.Index(path, "/zoneinfo/"); i >= 0 {
			tz := strings.TrimSpace(path[i+len("/zoneinfo/"):])
			if ianaTZPattern.MatchString(tz) {
				return tz, tz, nil
			}
		}
	}
	out, err := exec.Command("/usr/sbin/systemsetup", "-gettimezone").CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("systemsetup -gettimezone: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	tz := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "Time Zone:"))
	if !ianaTZPattern.MatchString(tz) {
		return "", "", fmt.Errorf("无法识别当前系统时区: %s", tz)
	}
	return tz, tz, nil
}

func appleScriptEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

func macHostProtectionApplyScript(timezone string, changeTimezone, flushDNS bool) string {
	parts := []string{}
	if changeTimezone {
		parts = append(parts, fmt.Sprintf("/usr/sbin/systemsetup -settimezone '%s' >/dev/null", timezone))
	}
	if flushDNS {
		parts = append(parts,
			"/usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true",
			"/usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true",
		)
	}
	return fmt.Sprintf(`do shell script "%s" with administrator privileges`, appleScriptEscape(strings.Join(parts, "; ")))
}

func hostProtectionApply(timezone string, changeTimezone, flushDNS bool) (hostProtectionApplyResult, error) {
	// 不改时区时省略低价值 DNS 清理，避免只为 DNS 单独弹管理员密码框。
	if !changeTimezone {
		return hostProtectionApplyResult{}, nil
	}
	if appActionsSuppressed() {
		return hostProtectionApplyResult{AppliedSystemTimezone: timezone, DNSCleared: flushDNS}, nil
	}
	script := macHostProtectionApplyScript(timezone, changeTimezone, flushDNS)
	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		return hostProtectionApplyResult{}, fmt.Errorf("管理员授权被取消或系统设置失败: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return hostProtectionApplyResult{AppliedSystemTimezone: timezone, DNSCleared: flushDNS}, nil
}

func hostProtectionRestore(originalSystemTimezone string, timezoneChanged bool) error {
	if !timezoneChanged || strings.TrimSpace(originalSystemTimezone) == "" {
		return nil
	}
	if appActionsSuppressed() {
		return nil
	}
	script := macHostProtectionApplyScript(originalSystemTimezone, true, false)
	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("恢复系统时区失败: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

//go:build linux

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

type hostProtectionApplyResult struct {
	AppliedSystemTimezone string
	DNSCleared            bool
}

func hostProtectionPlatform() string { return "linux" }

// 改系统时区需 root/polkit 授权,故与 macOS 一样在改时区时要求一次授权(pkexec 图形弹窗)。
func hostProtectionRequiresAuthorization(timezoneChanged bool) bool { return timezoneChanged }

func hostProtectionStopDesktopForPreferences() {}

// killProcessByName 结束指定进程(浏览器防封改 prefs 前先关浏览器)。调用方已过 appActionsSuppressed。
func killProcessByName(name string) {
	_ = exec.Command("pkill", "-x", name).Run()
}

// runPrivilegedLinux 以提权方式执行:优先 pkexec(polkit 图形授权,类比 mac 的 osascript 管理员弹窗),
// 已 root 时 pkexec 缺失则直接执行。
func runPrivilegedLinux(name string, args ...string) error {
	if _, err := exec.LookPath("pkexec"); err == nil {
		full := append([]string{name}, args...)
		return exec.Command("pkexec", full...).Run()
	}
	return exec.Command(name, args...).Run()
}

func hostProtectionReadTimezone() (string, string, error) {
	// /etc/localtime 通常是指向 /usr/share/zoneinfo/<Area>/<City> 的符号链接。
	if out, err := exec.Command("readlink", "-f", "/etc/localtime").Output(); err == nil {
		path := strings.TrimSpace(string(out))
		if i := strings.Index(path, "/zoneinfo/"); i >= 0 {
			tz := strings.TrimSpace(path[i+len("/zoneinfo/"):])
			if ianaTZPattern.MatchString(tz) {
				return tz, tz, nil
			}
		}
	}
	// 回退 timedatectl(systemd)。
	if out, err := exec.Command("timedatectl", "show", "--property=Timezone", "--value").Output(); err == nil {
		tz := strings.TrimSpace(string(out))
		if ianaTZPattern.MatchString(tz) {
			return tz, tz, nil
		}
	}
	return "", "", errors.New("无法读取 Linux 系统时区(需 systemd/timedatectl 或 /etc/localtime 符号链接)")
}

func hostProtectionApply(timezone string, changeTimezone, flushDNS bool) (hostProtectionApplyResult, error) {
	result := hostProtectionApplyResult{}
	if !changeTimezone {
		return result, nil
	}
	if appActionsSuppressed() {
		result.AppliedSystemTimezone = timezone
		result.DNSCleared = flushDNS
		return result, nil
	}
	if err := runPrivilegedLinux("timedatectl", "set-timezone", timezone); err != nil {
		return result, fmt.Errorf("设置 Linux 时区失败(需 timedatectl + 授权): %w", err)
	}
	result.AppliedSystemTimezone = timezone
	if flushDNS {
		// systemd-resolved 有就刷,没有忽略(best-effort,不阻塞接管)。
		if err := exec.Command("resolvectl", "flush-caches").Run(); err == nil {
			result.DNSCleared = true
		}
	}
	return result, nil
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

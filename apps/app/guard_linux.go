//go:build linux

package main

import (
	"os"
	"strings"
)

func detectDebugger() bool {
	// /proc/self/status 中 TracerPid 非零表示有调试器附加
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "TracerPid:") {
			pid := strings.TrimSpace(strings.TrimPrefix(line, "TracerPid:"))
			return pid != "0"
		}
	}
	return false
}

//go:build darwin

package main

import (
	"strings"

	"golang.org/x/sys/unix"
)

func diagnosticOSVersion() string {
	version, err := unix.Sysctl("kern.osproductversion")
	if err == nil && strings.TrimSpace(version) != "" {
		return strings.TrimSpace(version)
	}
	kernel, err := unix.Sysctl("kern.osrelease")
	if err == nil && strings.TrimSpace(kernel) != "" {
		return strings.TrimSpace(kernel)
	}
	return "unknown"
}

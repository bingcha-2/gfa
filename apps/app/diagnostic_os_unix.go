//go:build linux

package main

import (
	"bytes"

	"golang.org/x/sys/unix"
)

func diagnosticOSVersion() string {
	var info unix.Utsname
	if err := unix.Uname(&info); err != nil {
		return "unknown"
	}
	return string(bytes.TrimRight(info.Release[:], "\x00"))
}

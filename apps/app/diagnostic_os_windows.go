//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func diagnosticOSVersion() string {
	version := windows.RtlGetVersion()
	if version == nil {
		return "unknown"
	}
	return fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber)
}

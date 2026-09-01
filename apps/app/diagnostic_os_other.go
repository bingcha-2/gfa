//go:build !windows && !darwin && !linux

package main

func diagnosticOSVersion() string {
	return "unknown"
}

//go:build windows

package main

import "golang.org/x/sys/windows"

func replaceDiagnosticFile(from, to string) error {
	return windows.Rename(from, to)
}

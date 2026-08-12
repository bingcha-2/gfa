//go:build !windows

package main

import "os"

func replaceDiagnosticFile(from, to string) error {
	return os.Rename(from, to)
}

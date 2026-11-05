//go:build !windows

package main

import (
	"context"
	"os/exec"
)

// hideCmd on non-Windows is just exec.Command (no console window issue).
func hideCmd(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}

func hideCmdContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

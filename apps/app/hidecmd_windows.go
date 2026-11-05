//go:build windows

package main

import (
	"context"
	"os/exec"
	"syscall"
)

// hideCmd creates an exec.Cmd that won't show a console window on Windows.
// This prevents PowerShell/cmd/tasklist/taskkill from flashing a visible window.
func hideCmd(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

func hideCmdContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

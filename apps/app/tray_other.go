//go:build !windows

package main

import "context"

// startTray 仅在 Windows 实现系统托盘。其它平台为 no-op:
// macOS 关窗后用 Dock 重新唤起,Linux 走 shouldHideWindowOnClose 直接退出。
func startTray(ctx context.Context) {}

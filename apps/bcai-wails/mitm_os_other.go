//go:build !darwin && !windows

package main

import "fmt"

// Linux 及其它平台占位：Claude 桌面端无官方 Linux 版，detectClaudeDesktopPathAuto 返回空，
// 故接管 target 在这些平台显示「未检测到」、永不触发重启；以下函数仅为跨平台可编译。

func mitmInstallCA(certPath string) (caInstallResult, error) {
	return caInstallFailed, fmt.Errorf("mitm: CA 安装暂未在该平台实现")
}

func mitmUninstallCA() error {
	return fmt.Errorf("mitm: CA 卸载暂未在该平台实现")
}

func mitmIsCAInstalled() bool { return false }

func mitmCleanupLegacyUserCA() error { return nil }

func mitmCAInUserStore() bool { return false }

func detectClaudeDesktopPathAuto() string { return "" }

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string, chromiumProxy bool) error {
	return fmt.Errorf("mitm: 带代理重启 Claude 暂未在该平台实现")
}

func mitmRelaunchClaudePlain() error {
	return fmt.Errorf("mitm: 重启 Claude 暂未在该平台实现")
}

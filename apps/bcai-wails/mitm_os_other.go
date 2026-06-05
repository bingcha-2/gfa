//go:build !darwin

package main

import "fmt"

// 非 macOS 平台的占位实现。Windows/Linux 的装 CA(certutil / NSS db)与带代理重启
// 留待 Phase 2.2/2.3 实现；当前调用返回明确错误，保证跨平台可编译。

func mitmInstallCA(certPath string) error {
	return fmt.Errorf("mitm: CA 安装暂未在该平台实现")
}

func mitmUninstallCA() error {
	return fmt.Errorf("mitm: CA 卸载暂未在该平台实现")
}

func mitmIsCAInstalled() bool { return false }

func detectClaudeDesktopPath() string { return "" }

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string) error {
	return fmt.Errorf("mitm: 带代理重启 Claude 暂未在该平台实现")
}

func mitmRelaunchClaudePlain() error {
	return fmt.Errorf("mitm: 重启 Claude 暂未在该平台实现")
}

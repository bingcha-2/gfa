//go:build !darwin && !windows

package main

import "fmt"

func detectClaudeDesktopPathAuto() string { return "" }
func startClaudeDesktop() error           { return fmt.Errorf("当前平台不支持 Claude Desktop") }

func stopClaudeDesktop() {}

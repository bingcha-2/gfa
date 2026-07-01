package main

import "testing"

// appActionsSuppressed 报告是否应抑制「真去 open / kill 本机 GUI app」的副作用。
//
// 运行在 go test 下时为 true。集成测试(local_integration_test.go 等)用的是**真实**
// localPlatform + 真实 app 探测(detectCodexGUIPath 走 Spotlight/ /Applications,不受
// HOME 沙箱约束),若不拦,SetSource / 运行时控制会真的 open/kill 用户本机的 Codex /
// Antigravity —— 表现为「app 被偷偷拉起、被退出、进程堆积」。凭据文件写的是沙箱 HOME,
// 不受影响;这里只拦「拉起/杀进程」这类对本机 GUI 的真副作用。生产二进制恒 false。
func appActionsSuppressed() bool { return testing.Testing() }

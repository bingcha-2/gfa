package main

// shouldHideWindowOnClose 决定点窗口右上角关闭按钮(X)时,是隐藏窗口还是真正退出进程。
//
// Windows: 有系统托盘图标可重新唤起 → 隐藏(微信/QQ/杀软式:点 X 缩到托盘,后台继续跑,
//
//	退出走托盘右键菜单)。
//
// macOS:   有 Dock 图标可重新唤起、且 Cmd+Q 仍能退出 → 隐藏(平台习惯)。
// Linux:   本程序不构建托盘、桌面也未必有 Dock,隐藏会让窗口再也回不来 → 直接退出。
func shouldHideWindowOnClose(goos string) bool {
	return goos != "linux"
}

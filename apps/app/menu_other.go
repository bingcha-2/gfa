//go:build !darwin

package main

import "github.com/wailsapp/wails/v2/pkg/menu"

// addWindowMenu 仅 macOS 实现(把 ⌘W 绑成隐藏到后台,见 menu_darwin.go)。
// 其它平台 no-op:Windows 点 X 已缩托盘,Linux 无回退手段不做隐藏。
func addWindowMenu(appMenu *menu.Menu, app *App) {}

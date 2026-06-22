//go:build darwin

package main

import (
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// addWindowMenu 仅 macOS:加一个「窗口」菜单,把 ⌘W 绑成「隐藏到后台」,行为与点左上角红色
// 关闭按钮完全一致 —— runtime.Hide 走 [NSApp hide:nil],整个 App 隐藏但继续跑,点 Dock 图标
// 可重新唤回。
//
// 注意不能用 runtime.WindowHide:那是 orderOut 级的窗口隐藏,而 Wails v2 没注册
// applicationShouldHandleReopen 回调,orderOut 后点 Dock 唤不回来,窗口就再也回不来了。
//
// Windows/Linux 不加此项(见 menu_other.go):Windows 点 X 已缩托盘,Linux 无回退手段。
func addWindowMenu(appMenu *menu.Menu, app *App) {
	windowMenu := appMenu.AddSubmenu("窗口")
	windowMenu.AddText("关闭窗口", keys.CmdOrCtrl("w"), func(_ *menu.CallbackData) {
		if app.ctx != nil {
			runtime.Hide(app.ctx)
		}
	})
}

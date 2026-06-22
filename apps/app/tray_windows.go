//go:build windows

package main

import (
	"context"
	_ "embed"
	goruntime "runtime"

	"fyne.io/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// trayIconICO 是托盘图标(Windows 托盘只认 .ico),直接复用打包用的应用图标。
//
//go:embed build/windows/icon.ico
var trayIconICO []byte

// startTray 在 Windows 系统托盘放置图标 + 菜单(打开主窗口 / 退出),配合
// HideWindowOnClose 实现"点 X 不退出、缩到托盘,退出走托盘菜单"的微信/QQ 式行为。
//
// systray 在 Windows 用隐藏窗口跑消息循环,GetMessage 必须与创建该窗口的线程是同一个;
// Go 协程默认会在 OS 线程间迁移,故进 goroutine 后先 LockOSThread 把它钉死,避免消息循环错乱。
func startTray(ctx context.Context) {
	go func() {
		goruntime.LockOSThread()
		systray.Run(func() { onTrayReady(ctx) }, func() {})
	}()
}

func onTrayReady(ctx context.Context) {
	systray.SetIcon(trayIconICO)
	systray.SetTitle("冰茶AI")
	systray.SetTooltip("冰茶AI")

	// 左键单击托盘图标 = 恢复并显示主窗口。fyne v1.12.2 在 Windows 上只投递单击事件、不区分
	// 双击,因此单击即恢复 —— 这是"双击恢复"需求的超集(双击的第一下就已把窗口拉回前台)。
	systray.SetOnTapped(func() { showMainWindow(ctx) })

	// 右键单击托盘图标 = 弹出菜单(未设置 SetOnSecondaryTapped 时 systray 默认行为)。
	mShow := systray.AddMenuItem("打开主窗口", "恢复并显示冰茶AI主窗口")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("退出", "退出冰茶AI")

	for {
		select {
		case <-mShow.ClickedCh:
			showMainWindow(ctx)
		case <-mQuit.ClickedCh:
			// 先停托盘消息循环并清理托盘图标(systray.Quit 内部会 delete 托盘 NID),
			// 再走 Wails 正常退出(Quit 不经过 X 的 HideWindowOnClose 拦截,直接结束进程)。
			systray.Quit()
			runtime.Quit(ctx)
			return
		}
	}
}

// showMainWindow 把主窗口恢复并拉到桌面前台:无论它此前是被最小化还是被关到托盘隐藏。
func showMainWindow(ctx context.Context) {
	runtime.WindowUnminimise(ctx)
	runtime.WindowShow(ctx)
}

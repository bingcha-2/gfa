package main

import (
	"embed"
	goruntime "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// 稳定且跨版本不变。Windows 上由 Wails 创建命名 Mutex；macOS/Linux 使用对应平台的
// 单实例机制。第二次启动只唤醒已有窗口，不会再创建另一套 app/proxy/watchdog。
const appSingleInstanceID = "com.bcai.bingchaai.desktop"

func main() {
	app := NewApp()

	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	appMenu.Append(menu.EditMenu())
	// macOS:补一个「窗口」菜单,把 ⌘W 绑成「隐藏到后台」(与红色关闭按钮一致)。其它平台 no-op。
	addWindowMenu(appMenu, app)

	err := wails.Run(&options.App{
		Title:     "冰茶AI",
		Width:     1024,
		Height:    768,
		MinWidth:  800,
		MinHeight: 600,
		Menu:      appMenu,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 246, G: 245, B: 242, A: 255},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: appSingleInstanceID,
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				if app.ctx == nil {
					return
				}
				Log("[app] 检测到重复启动，已唤醒现有窗口")
				wailsruntime.WindowUnminimise(app.ctx)
				wailsruntime.WindowShow(app.ctx)
			},
		},
		// 点 X 不退出:Windows 缩到托盘、macOS 缩到 Dock,后台继续跑(退出走托盘菜单/Cmd+Q)。
		HideWindowOnClose: shouldHideWindowOnClose(goruntime.GOOS),
		OnStartup:         app.startup,
		Bind: []interface{}{
			app,
		},
		Mac: &mac.Options{
			TitleBar:             mac.TitleBarHiddenInset(),
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

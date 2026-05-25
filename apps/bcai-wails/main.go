package main

import (
	"embed"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	appMenu.Append(menu.EditMenu())

	// View menu — refresh
	viewMenu := appMenu.AddSubmenu("视图")
	viewMenu.AddText("刷新", keys.CmdOrCtrl("r"), func(_ *menu.CallbackData) {
		wailsRuntime.WindowReloadApp(app.ctx)
	})

	// Window menu — minimize, zoom, close
	windowMenu := appMenu.AddSubmenu("窗口")
	windowMenu.AddText("最小化", keys.CmdOrCtrl("m"), func(_ *menu.CallbackData) {
		wailsRuntime.WindowMinimise(app.ctx)
	})
	windowMenu.AddText("缩放", nil, func(_ *menu.CallbackData) {
		wailsRuntime.WindowToggleMaximise(app.ctx)
	})
	windowMenu.AddText("关闭窗口", keys.CmdOrCtrl("w"), func(_ *menu.CallbackData) {
		wailsRuntime.WindowMinimise(app.ctx)
	})

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
		OnStartup:        app.startup,
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

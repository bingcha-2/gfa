package main

// 实例增强字段(launchMode / appSpeed / followLocalAccount / quick config)Wails 绑定。
// 仅薄薄委托给 hub;红线:只读写本地实例库 JSON,不碰远程租号 / proxy.go / 网关出口。
//
// quickContextWindow/quickAutoCompact 用指针:nil 表示「不配置/继承官方」。Wails 前端
// 传 number 会到非 nil;传 null 到 nil(对齐 instance 包语义)。

func (a *App) LocalInstanceSetQuickConfig(
	id, launchMode, appSpeed string,
	followLocalAccount bool,
	quickContextWindow, quickAutoCompact *int64,
) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.InstanceSetQuickConfig(id, launchMode, appSpeed, followLocalAccount, quickContextWindow, quickAutoCompact)
}

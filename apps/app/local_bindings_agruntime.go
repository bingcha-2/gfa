package main

// Antigravity 本地接管注入目标(IDE / 独立版)Wails 绑定 —— 仅薄薄委托给 hub。
// 决定本地自有号注入进哪个 app 的 state.vscdb;红线:只影响本地落点,不碰远程租号 / 网关出口。
// (手动 app 启停面板 + 切号历史已下线:切号后由 hub 自动重启当前注入目标 app 生效。)

// LocalGetAntigravityTarget 返回本地接管注入的目标 app 变体("ide"/"standalone")。
func (a *App) LocalGetAntigravityTarget() string {
	if err := ensureLocal(); err != nil {
		return "ide"
	}
	return localHub.GetAntigravityTarget()
}

// LocalSetAntigravityTarget 设注入目标 app 变体(local 接管态下立即重注入到新目标)。
func (a *App) LocalSetAntigravityTarget(variant string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetAntigravityTarget(variant)
}

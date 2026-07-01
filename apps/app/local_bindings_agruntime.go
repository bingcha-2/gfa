package main

// Antigravity 本地接管(按 app 独立)Wails 绑定 —— 仅薄薄委托给 hub。
// IDE 与独立版各自可单独把自有号注入其 state.vscdb,互不影响(和远程那两行对称)。
// 红线:只影响本地注入落点(直连官方),不碰远程租号 / 网关出口。

// LocalAntigravityLocalInjected 报告某 Antigravity app 变体(ide/standalone)是否本地自有号接管中。
func (a *App) LocalAntigravityLocalInjected(variant string) bool {
	if err := ensureLocal(); err != nil {
		return false
	}
	return localHub.AntigravityLocalInjected(variant)
}

// LocalSetAntigravityLocalInjected 独立开/关某 app 变体的本地自有号注入接管。
func (a *App) LocalSetAntigravityLocalInjected(variant string, on bool) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetAntigravityLocalInjected(variant, on)
}

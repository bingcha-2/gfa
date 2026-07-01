package main

// Wave L:按号服务档(codex 专属)Wails 绑定 —— 薄委托给 hub.SetCodexAccountServiceTier。
// 隔离在独立文件,避免改动共享的 local_bindings.go。

// LocalSetCodexAccountServiceTier 设某 codex 自有号的按号服务档:
//   - tier="fast" → 快速(出口目标 service_tier:"priority");
//   - tier=""/"standard" → 继承标准档。
//
// 仅 codex 支持;对非 codex 号返回错误(见 hub.SetCodexAccountServiceTier)。
func (a *App) LocalSetCodexAccountServiceTier(id, tier string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetCodexAccountServiceTier(id, tier)
}

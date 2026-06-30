package main

import "bcai-wails/internal/local/aghistory"

// Antigravity 默认实例运行时控制 + 切号历史 Wails 绑定 —— 仅薄薄委托给 hub。
// 运行时动作经 hub.Platform(localPlatform)拉起/聚焦/停已装 IDE 进程。
// 红线:运行时只控制本机 IDE 进程,切号历史只读写本地 JSON,均与远程租号 / 网关出口无关。

// ── 默认实例运行时 ──

func (a *App) LocalAntigravityStartDefault() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.AntigravityStartDefault()
}

func (a *App) LocalAntigravityStopDefault() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.AntigravityStopDefault()
}

func (a *App) LocalAntigravityRestartDefault() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.AntigravityRestartDefault()
}

func (a *App) LocalAntigravityFocusDefault() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.AntigravityFocusDefault()
}

func (a *App) LocalAntigravityRuntimeStatus() bool {
	if err := ensureLocal(); err != nil {
		return false
	}
	return localHub.AntigravityRuntimeStatus()
}

// ── 切号历史 ──

func (a *App) LocalAntigravitySwitchHistory() ([]aghistory.SwitchHistoryItem, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.AntigravitySwitchHistory()
}

func (a *App) LocalAddAntigravitySwitchHistory(item aghistory.SwitchHistoryItem) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.AddAntigravitySwitchHistory(item)
}

func (a *App) LocalClearAntigravitySwitchHistory() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.ClearAntigravitySwitchHistory()
}

package hub

import "bcai-wails/internal/local/aghistory"

// Antigravity「默认实例」运行时控制 + 切号历史的薄委托。
//
// 运行时控制(start/stop/restart/focus/status)是平台专有动作(拉起/聚焦/停已装 IDE
// 进程),经 Platform 接口注入,实现在 package main(复用既有探测/启停)。
// 切号历史是 aghistory 自包含包(camelCase JSON 原子持久化、去重降序截断 200)。
//
// 红线:运行时只控制本机 IDE 进程,切号历史只读写本地 JSON,均与远程租号 / 网关出口无关。

// ── 默认实例运行时(对齐 cockpit runtime.*Default) ──

// AntigravityStartDefault 拉起 Antigravity 默认实例(已装 IDE)。
func (h *Hub) AntigravityStartDefault() error { return h.platform.AntigravityStartDefault() }

// AntigravityStopDefault 停掉 Antigravity 默认实例进程。
func (h *Hub) AntigravityStopDefault() error { return h.platform.AntigravityStopDefault() }

// AntigravityRestartDefault 先停后起(对齐 cockpit:stop 失败也继续 start)。
func (h *Hub) AntigravityRestartDefault() error {
	_ = h.platform.AntigravityStopDefault()
	return h.platform.AntigravityStartDefault()
}

// AntigravityFocusDefault 把 Antigravity 默认实例窗口带到前台。
func (h *Hub) AntigravityFocusDefault() error { return h.platform.AntigravityFocusDefault() }

// AntigravityRuntimeStatus 返回默认实例是否在运行。
func (h *Hub) AntigravityRuntimeStatus() bool { return h.platform.AntigravityRuntimeRunning() }

// ── 切号历史(对齐 cockpit antigravity_switch_history) ──

// AntigravitySwitchHistory 返回切号历史(降序;缺省/损坏返回空切片)。
func (h *Hub) AntigravitySwitchHistory() ([]aghistory.SwitchHistoryItem, error) {
	return h.agHistory.Load()
}

// AddAntigravitySwitchHistory 追加一条切号历史(按 id 去重、按 timestamp 降序、截断 200)。
func (h *Hub) AddAntigravitySwitchHistory(item aghistory.SwitchHistoryItem) error {
	return h.agHistory.Add(item)
}

// ClearAntigravitySwitchHistory 清空切号历史。
func (h *Hub) ClearAntigravitySwitchHistory() error { return h.agHistory.Clear() }

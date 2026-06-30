package hub

import (
	"fmt"

	"bcai-wails/internal/local/instance"
)

// 实例增强字段(launchMode / appSpeed / followLocalAccount / quick config)的薄委托。
// instance.Profile 已含这些字段(前向迁移),本文件提供「按 id 局部设置」入口,
// 避免前端必须整对象 Update(也便于 quick config 用指针区分「删键」与「不动」)。
//
// 红线:只读写本地实例库 JSON,与远程租号 / proxy.go / 网关出口无关。

// InstanceSetQuickConfig 局部设置某实例的启动/速度/跟随/快捷上下文配置。
// quickContextWindow/quickAutoCompact 为 nil 表示「不配置/继承官方」(对齐 instance 包语义)。
func (h *Hub) InstanceSetQuickConfig(id, launchMode, appSpeed string, followLocalAccount bool, quickContextWindow, quickAutoCompact *int64) error {
	p, ok := h.instances.Get(id)
	if !ok {
		return fmt.Errorf("实例不存在")
	}
	p.LaunchMode = normalizeLaunchMode(launchMode)
	p.AppSpeed = normalizeAppSpeed(appSpeed)
	p.FollowLocalAccount = followLocalAccount
	p.QuickContextWindow = quickContextWindow
	p.QuickAutoCompact = quickAutoCompact
	return h.instances.Update(p)
}

func normalizeLaunchMode(s string) string {
	if s == instance.LaunchModeCLI {
		return instance.LaunchModeCLI
	}
	return instance.LaunchModeGUI
}

func normalizeAppSpeed(s string) string {
	if s == instance.AppSpeedFast {
		return instance.AppSpeedFast
	}
	return instance.AppSpeedStandard
}

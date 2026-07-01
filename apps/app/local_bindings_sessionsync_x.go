package main

import "bcai-wails/internal/local/sessionsync"

// 跨实例会话同步 / 可见性修复(Wave N)Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:只读写本地会话文件,不碰远程租号 / proxy.go / 网关出口。

// LocalSyncCodexSessionsToInstance 把若干会话恢复/复制到目标实例。
func (a *App) LocalSyncCodexSessionsToInstance(sessionIDs []string, targetInstanceID string) (sessionsync.SyncToInstanceSummary, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.SyncToInstanceSummary{}, err
	}
	return localHub.SyncSessionsToInstance(sessionIDs, targetInstanceID)
}

// LocalSyncCodexThreadsAcrossInstances 跨实例去重/对齐线程。
func (a *App) LocalSyncCodexThreadsAcrossInstances() (sessionsync.ThreadSyncSummary, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.ThreadSyncSummary{}, err
	}
	return localHub.SyncThreadsAcrossInstances()
}

// LocalRepairCodexSessionVisibility 重建/校正跨实例会话可见性(targetProvider 为空=各实例读自己 config)。
func (a *App) LocalRepairCodexSessionVisibility(targetProvider string) (sessionsync.VisibilityRepairSummary, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.VisibilityRepairSummary{}, err
	}
	return localHub.RepairSessionVisibility(targetProvider)
}

// LocalListCodexSessionVisibilityRepairInstances 列可见性修复候选实例(带当前 provider)。
func (a *App) LocalListCodexSessionVisibilityRepairInstances() ([]sessionsync.RepairInstanceOption, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListVisibilityRepairInstances()
}

// LocalListCodexSessionVisibilityRepairProviders 列可见性修复候选 provider(config + rollout)。
func (a *App) LocalListCodexSessionVisibilityRepairProviders() (sessionsync.RepairProviderList, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.RepairProviderList{}, err
	}
	return localHub.ListVisibilityRepairProviders()
}

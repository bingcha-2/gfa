package hub

import "bcai-wails/internal/local/sessionsync"

// 跨实例会话同步 / 可见性修复(Wave N)的 hub 薄委托:实例集合从实例库映射(复用
// sessionInstances),纯逻辑在 sessionsync 包。
//
// 红线:只读写本地会话文件,与远程租号 / proxy.go / 网关出口无关。

// SyncSessionsToInstance 把若干会话恢复/复制到目标实例。
func (h *Hub) SyncSessionsToInstance(sessionIDs []string, targetInstanceID string) (sessionsync.SyncToInstanceSummary, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return sessionsync.SyncToInstanceSummary{}, err
	}
	return sessionsync.SyncToInstance(insts, sessionIDs, targetInstanceID)
}

// SyncThreadsAcrossInstances 跨实例去重/对齐线程(把每个实例缺失的会话补齐)。
func (h *Hub) SyncThreadsAcrossInstances() (sessionsync.ThreadSyncSummary, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return sessionsync.ThreadSyncSummary{}, err
	}
	return sessionsync.SyncThreadsAcrossInstances(insts)
}

// RepairSessionVisibility 重建/校正跨实例会话可见性(targetProvider 为空则各实例读自己 config)。
func (h *Hub) RepairSessionVisibility(targetProvider string) (sessionsync.VisibilityRepairSummary, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return sessionsync.VisibilityRepairSummary{}, err
	}
	return sessionsync.VisibilityRepair(insts, targetProvider)
}

// ListVisibilityRepairInstances 列可见性修复的候选实例(带当前 provider)。
func (h *Hub) ListVisibilityRepairInstances() ([]sessionsync.RepairInstanceOption, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return nil, err
	}
	return sessionsync.ListRepairInstances(insts)
}

// ListVisibilityRepairProviders 列可见性修复的候选 provider(config + rollout 来源)。
func (h *Hub) ListVisibilityRepairProviders() (sessionsync.RepairProviderList, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return sessionsync.RepairProviderList{}, err
	}
	return sessionsync.ListRepairProviders(insts)
}

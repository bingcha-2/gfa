package hub

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/accountgroups"
)

// 账号组织(分组)的薄委托:CRUD + 成员分配 + 账号→分组解析。
// accountgroups 是自包含纯逻辑包(camelCase JSON 原子持久化),本文件只做委托
// 与「删账号后清理分组成员」的集成。
//
// 红线:只读写本地分组 JSON,与远程租号 / proxy.go / 网关出口无关。

// ListAccountGroups 返回全部分组(按 sortOrder 升序)。
func (h *Hub) ListAccountGroups() ([]accountgroups.Group, error) { return h.groups.List() }

// CreateAccountGroup 新建分组(trim 名称,SortOrder = max+1)。
func (h *Hub) CreateAccountGroup(name string) (accountgroups.Group, error) {
	return h.groups.Create(name)
}

// RenameAccountGroup 改分组名;分组不存在返回 (nil,nil)。
func (h *Hub) RenameAccountGroup(groupID, name string) (*accountgroups.Group, error) {
	return h.groups.Rename(groupID, name)
}

// UpdateAccountGroupSortOrder 改分组排序序号。
func (h *Hub) UpdateAccountGroupSortOrder(groupID string, sortOrder int) (*accountgroups.Group, error) {
	return h.groups.UpdateSortOrder(groupID, sortOrder)
}

// DeleteAccountGroup 删除分组。
func (h *Hub) DeleteAccountGroup(groupID string) error { return h.groups.Delete(groupID) }

// AssignAccountsToGroup 把账号加入分组(账号互斥:从其它分组移除后并入)。
func (h *Hub) AssignAccountsToGroup(groupID string, accountIDs []string) (*accountgroups.Group, error) {
	return h.groups.Assign(groupID, accountIDs)
}

// RemoveAccountsFromGroup 把账号移出分组。
func (h *Hub) RemoveAccountsFromGroup(groupID string, accountIDs []string) (*accountgroups.Group, error) {
	return h.groups.RemoveAccounts(groupID, accountIDs)
}

// GroupOfAccount 返回某账号所属分组 id;无分组返回 ""。
func (h *Hub) GroupOfAccount(accountID string) string {
	groups, err := h.groups.List()
	if err != nil {
		return ""
	}
	return accountgroups.GroupOfAccount(groups, accountID)
}

// ResolveAccountGroups 返回 accountID→groupID 映射(前端一次性渲染分组归属)。
func (h *Hub) ResolveAccountGroups() (map[string]string, error) {
	groups, err := h.groups.List()
	if err != nil {
		return nil, err
	}
	return accountgroups.ResolveAccountGroups(groups), nil
}

// cleanupAccountGroups 用「当前仍存在的账号集合」清理分组里已删除的账号成员。
// 删账号后调用(分组是 codex/antigravity 共用的本地组织,按存在性清理即可)。
func (h *Hub) cleanupAccountGroups() {
	existing := map[string]bool{}
	for _, p := range []account.Provider{account.ProviderCodex, account.ProviderAntigravity} {
		list, err := h.acc.List(p)
		if err != nil {
			return // 列号失败时不冒险清理(避免误删成员)。
		}
		for _, a := range list {
			existing[a.ID] = true
		}
	}
	_ = h.groups.CleanupDeletedAccounts(existing)
}

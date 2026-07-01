package main

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/accountgroups"
	"bcai-wails/internal/local/manager"
)

// 账号组织(分组)+ 显式当前号 get/set + 重排序 Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:只读写本地分组 JSON 与账号优先级/排序,不碰远程租号 / proxy.go / 网关出口。

// ── 账号分组 CRUD + 成员 ──

func (a *App) LocalListAccountGroups() ([]accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListAccountGroups()
}

func (a *App) LocalCreateAccountGroup(name string) (accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return accountgroups.Group{}, err
	}
	return localHub.CreateAccountGroup(name)
}

func (a *App) LocalRenameAccountGroup(groupID, name string) (*accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.RenameAccountGroup(groupID, name)
}

func (a *App) LocalUpdateAccountGroupSortOrder(groupID string, sortOrder int) (*accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.UpdateAccountGroupSortOrder(groupID, sortOrder)
}

func (a *App) LocalDeleteAccountGroup(groupID string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.DeleteAccountGroup(groupID)
}

func (a *App) LocalAssignAccountsToGroup(groupID string, accountIDs []string) (*accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.AssignAccountsToGroup(groupID, accountIDs)
}

func (a *App) LocalRemoveAccountsFromGroup(groupID string, accountIDs []string) (*accountgroups.Group, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.RemoveAccountsFromGroup(groupID, accountIDs)
}

func (a *App) LocalResolveAccountGroups() (map[string]string, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ResolveAccountGroups()
}

// ── 显式当前号 get/set(按 provider) ──

func (a *App) LocalCurrentCodexAccount() (*manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.CurrentAccount(account.ProviderCodex)
}

func (a *App) LocalSetCurrentCodexAccount(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetCurrentAccount(account.ProviderCodex, id)
}

func (a *App) LocalCurrentAntigravityAccount() (*manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.CurrentAccount(account.ProviderAntigravity)
}

func (a *App) LocalSetCurrentAntigravityAccount(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetCurrentAccount(account.ProviderAntigravity, id)
}

// ── 重排序(按 provider) ──

func (a *App) LocalReorderCodexAccounts(ids []string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.ReorderAccounts(account.ProviderCodex, ids)
}

func (a *App) LocalReorderAntigravityAccounts(ids []string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.ReorderAccounts(account.ProviderAntigravity, ids)
}

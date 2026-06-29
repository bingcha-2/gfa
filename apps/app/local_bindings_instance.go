package main

import (
	"bcai-wails/internal/local/instance"
)

// ───────────────────────── 多实例 profile 管理 ─────────────────────────
// 实际启动/停止真实 app(进程隔离 user-data-dir)属平台集成,需真机,后续接入。

func (a *App) LocalInstanceList(provider string) ([]*instance.Profile, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localInstances.List(provider)
}

func (a *App) LocalInstanceCreate(provider, name, userDataDir, workingDir, extraArgs, bindAccountID string) (*instance.Profile, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	p := &instance.Profile{
		Provider: provider, Name: name, UserDataDir: userDataDir,
		WorkingDir: workingDir, ExtraArgs: extraArgs, BindAccountID: bindAccountID,
	}
	if err := localInstances.Create(p); err != nil {
		return nil, err
	}
	return p, nil
}

func (a *App) LocalInstanceUpdate(p instance.Profile) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localInstances.Update(&p)
}

func (a *App) LocalInstanceDelete(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localInstances.Delete(id)
}

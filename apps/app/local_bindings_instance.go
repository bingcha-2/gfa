package main

import (
	"fmt"

	"bcai-wails/internal/local/instance"
)

// ───────────────────────── 多实例 profile 管理 ─────────────────────────
// 启动/停止见 local_instance_launch.go(真机生效,需已装目标 app)。

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

// LocalInstanceLaunch 以隔离 user-data-dir 启动实例(真机生效,需已装目标 app)。
func (a *App) LocalInstanceLaunch(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	p, ok := localInstances.Get(id)
	if !ok {
		return fmt.Errorf("实例不存在")
	}
	pid, err := launchInstance(p)
	if err != nil {
		return err
	}
	return localInstances.SetPid(id, pid)
}

// LocalInstanceStop 停止实例(best-effort kill;macOS 经 open 拉起的精确停止待细化)。
func (a *App) LocalInstanceStop(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	p, ok := localInstances.Get(id)
	if !ok {
		return fmt.Errorf("实例不存在")
	}
	if p.Pid > 0 {
		_ = stopInstance(p.Pid)
	}
	return localInstances.SetPid(id, 0)
}

package main

import (
	"context"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/wakeup"
)

// ───────────────────────── Wakeup 保活(per provider) ─────────────────────────

func (a *App) wakeupConfig(p account.Provider) (wakeup.Config, error) {
	pc, err := ctxFor(p)
	if err != nil {
		return wakeup.Config{}, err
	}
	return pc.wk.GetConfig(), nil
}

func (a *App) setWakeupConfig(p account.Provider, enabled bool, intervalMinutes int) error {
	pc, err := ctxFor(p)
	if err != nil {
		return err
	}
	cfg := wakeup.Config{Enabled: enabled, IntervalMinutes: intervalMinutes}
	pc.wk.SetConfig(cfg)
	return pc.wkCfg.Save(pc.wk.GetConfig())
}

func (a *App) wakeupRunNow(p account.Provider) ([]wakeup.RunEntry, error) {
	pc, err := ctxFor(p)
	if err != nil {
		return nil, err
	}
	return pc.wk.RunOnce(context.Background(), time.Now().UnixMilli()), nil
}

func (a *App) wakeupHistory(p account.Provider) ([]wakeup.RunEntry, error) {
	pc, err := ctxFor(p)
	if err != nil {
		return nil, err
	}
	return pc.wk.History(), nil
}

func (a *App) LocalCodexWakeupConfig() (wakeup.Config, error) {
	return a.wakeupConfig(account.ProviderCodex)
}
func (a *App) LocalSetCodexWakeupConfig(enabled bool, intervalMinutes int) error {
	return a.setWakeupConfig(account.ProviderCodex, enabled, intervalMinutes)
}
func (a *App) LocalCodexWakeupRunNow() ([]wakeup.RunEntry, error) {
	return a.wakeupRunNow(account.ProviderCodex)
}
func (a *App) LocalCodexWakeupHistory() ([]wakeup.RunEntry, error) {
	return a.wakeupHistory(account.ProviderCodex)
}

func (a *App) LocalAntigravityWakeupConfig() (wakeup.Config, error) {
	return a.wakeupConfig(account.ProviderAntigravity)
}
func (a *App) LocalSetAntigravityWakeupConfig(enabled bool, intervalMinutes int) error {
	return a.setWakeupConfig(account.ProviderAntigravity, enabled, intervalMinutes)
}
func (a *App) LocalAntigravityWakeupRunNow() ([]wakeup.RunEntry, error) {
	return a.wakeupRunNow(account.ProviderAntigravity)
}
func (a *App) LocalAntigravityWakeupHistory() ([]wakeup.RunEntry, error) {
	return a.wakeupHistory(account.ProviderAntigravity)
}

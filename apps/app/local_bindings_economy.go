package main

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/economy"
)

// 经济与自动化(① 超额预警 ② 自动切号 ③ 速度档)Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:自动切号只动 codex 自有号优先级与本机注入;不碰远程租号 / proxy.go。

// ── ① 超额预警 ──

func (a *App) LocalGetAlertConfig() (economy.AlertConfig, error) {
	if err := ensureLocal(); err != nil {
		return economy.AlertConfig{}, err
	}
	return localHub.GetAlertConfig(), nil
}

func (a *App) LocalSetAlertConfig(cfg economy.AlertConfig) (economy.AlertConfig, error) {
	if err := ensureLocal(); err != nil {
		return economy.AlertConfig{}, err
	}
	return localHub.SetAlertConfig(cfg)
}

// LocalEvaluateCodexAlert 对 codex 当前(优先级)号求一次预警判定(纯判定,不派发)。
func (a *App) LocalEvaluateCodexAlert() (economy.AlertResult, error) {
	if err := ensureLocal(); err != nil {
		return economy.AlertResult{}, err
	}
	return localHub.EvaluateAlert(account.ProviderCodex)
}

// ── ② 自动切号 ──

func (a *App) LocalGetSwitchConfig() (economy.SwitchConfig, error) {
	if err := ensureLocal(); err != nil {
		return economy.SwitchConfig{}, err
	}
	return localHub.GetSwitchConfig(), nil
}

func (a *App) LocalSetSwitchConfig(cfg economy.SwitchConfig) (economy.SwitchConfig, error) {
	if err := ensureLocal(); err != nil {
		return economy.SwitchConfig{}, err
	}
	return localHub.SetSwitchConfig(cfg)
}

// ── ③ 速度档 ──

func (a *App) LocalGetAppSpeed() (economy.AppSpeed, error) {
	if err := ensureLocal(); err != nil {
		return economy.AppSpeed{}, err
	}
	return localHub.GetAppSpeed(), nil
}

func (a *App) LocalSetAppSpeed(s economy.AppSpeed) (economy.AppSpeed, error) {
	if err := ensureLocal(); err != nil {
		return economy.AppSpeed{}, err
	}
	return localHub.SetAppSpeed(s)
}

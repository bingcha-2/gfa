package main

import "bcai-wails/internal/local/gatewaycfg"

// 网关运维配置(超时 / 预设 / 上游代理)Wails 绑定 —— 薄委托给 hub。
// 对齐 cockpit localAccess.updateTimeouts / updateTimeoutPresets / updateUpstreamProxyConfig。

func (a *App) LocalGetGatewayOpsConfig() (gatewaycfg.OpsConfig, error) {
	if err := ensureLocal(); err != nil {
		return gatewaycfg.OpsConfig{}, err
	}
	return localHub.GetGatewayOpsConfig(), nil
}

func (a *App) LocalSaveGatewayTimeouts(t gatewaycfg.Timeouts) (gatewaycfg.OpsConfig, error) {
	if err := ensureLocal(); err != nil {
		return gatewaycfg.OpsConfig{}, err
	}
	return localHub.SaveGatewayTimeouts(t)
}

func (a *App) LocalSaveGatewayTimeoutPresets(presets []gatewaycfg.TimeoutPreset) (gatewaycfg.OpsConfig, error) {
	if err := ensureLocal(); err != nil {
		return gatewaycfg.OpsConfig{}, err
	}
	return localHub.SaveGatewayTimeoutPresets(presets)
}

func (a *App) LocalActivateGatewayTimeoutPreset(id string) (gatewaycfg.OpsConfig, error) {
	if err := ensureLocal(); err != nil {
		return gatewaycfg.OpsConfig{}, err
	}
	return localHub.ActivateGatewayTimeoutPreset(id)
}

func (a *App) LocalSaveGatewayUpstreamProxy(raw string) (gatewaycfg.OpsConfig, error) {
	if err := ensureLocal(); err != nil {
		return gatewaycfg.OpsConfig{}, err
	}
	return localHub.SaveGatewayUpstreamProxy(raw)
}

package hub

import "bcai-wails/internal/local/gatewaycfg"

// 网关运维配置(超时 / 超时预设 / 上游代理)—— 对齐 cockpit localAccess.updateTimeouts /
// updateTimeoutPresets / updateUpstreamProxyConfig。持久化 + 暴露给前端。
//
// 注:把这些值真正套到内嵌 CLIProxyAPI 运行时(逐请求超时 / 出口上游代理)需 SDK 层支持,
// 暂以持久化 + 展示为主(与 authsync 按号档同类边界处理);runtime 应用为后续。
// 红线不变:网关只服务 codex 自有号,不碰远程租号。

// GetGatewayOpsConfig 返回网关运维配置(缺省回退默认)。
func (h *Hub) GetGatewayOpsConfig() gatewaycfg.OpsConfig { return h.gwOps.Load() }

// SaveGatewayTimeouts 保存超时配置(归一后返回全量)。
func (h *Hub) SaveGatewayTimeouts(t gatewaycfg.Timeouts) (gatewaycfg.OpsConfig, error) {
	return h.gwOps.SaveTimeouts(t)
}

// SaveGatewayTimeoutPresets 保存超时预设集合。
func (h *Hub) SaveGatewayTimeoutPresets(presets []gatewaycfg.TimeoutPreset) (gatewaycfg.OpsConfig, error) {
	return h.gwOps.SavePresets(presets)
}

// ActivateGatewayTimeoutPreset 激活某超时预设(把其超时套为当前)。
func (h *Hub) ActivateGatewayTimeoutPreset(id string) (gatewaycfg.OpsConfig, error) {
	return h.gwOps.ActivatePreset(id)
}

// SaveGatewayUpstreamProxy 保存出口上游代理 URL(空=直连)。
func (h *Hub) SaveGatewayUpstreamProxy(raw string) (gatewaycfg.OpsConfig, error) {
	return h.gwOps.SaveUpstreamProxy(raw)
}

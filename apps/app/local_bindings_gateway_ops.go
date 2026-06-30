package main

import (
	"bcai-wails/internal/local/gateway"
	"bcai-wails/internal/local/gatewaykeys"
	"bcai-wails/internal/local/stats"
)

// 反代(codex 网关)运营 Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:全部只服务 codex 自有号网关;不碰远程租号路径。

// ── 路由策略(round-robin / priority / fair) ──

func (a *App) LocalGetRoutingStrategy() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.GetRoutingStrategy(), nil
}

func (a *App) LocalSetRoutingStrategy(strategy string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetRoutingStrategy(strategy)
}

// ── 网关访问 key(客户端调本地 /v1 用) ──

func (a *App) LocalListGatewayKeys() ([]gatewaykeys.Key, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListGatewayKeys(), nil
}

func (a *App) LocalCreateGatewayKey(name string) (gatewaykeys.Key, error) {
	if err := ensureLocal(); err != nil {
		return gatewaykeys.Key{}, err
	}
	return localHub.CreateGatewayKey(name)
}

func (a *App) LocalDeleteGatewayKey(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.DeleteGatewayKey(id)
}

func (a *App) LocalRotateGatewayKey(id string) (gatewaykeys.Key, error) {
	if err := ensureLocal(); err != nil {
		return gatewaykeys.Key{}, err
	}
	return localHub.RotateGatewayKey(id)
}

// ── 局域网范围(local=仅本机 / lan=局域网;默认仅本机) ──

func (a *App) LocalGetGatewayAccessScope() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.GetGatewayAccessScope(), nil
}

func (a *App) LocalSetGatewayAccessScope(scope string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetGatewayAccessScope(scope)
}

// ── 请求日志(分页 + 过滤 + 清空) ──

// LocalQueryGatewayLogs 分页查询请求日志。filterJSON 为空表示无额外过滤;
// 支持字段:{"model":"","authId":"","failedOnly":false}。
func (a *App) LocalQueryGatewayLogs(offset, limit int, filterJSON string) (stats.LogPage, error) {
	if err := ensureLocal(); err != nil {
		return stats.LogPage{}, err
	}
	return localHub.QueryGatewayLogs(offset, limit, filterJSON)
}

func (a *App) LocalClearGatewayStats() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.ClearGatewayStats()
}

// ── 连通测试 ──

// LocalGatewayConnTest 对本地网关发一个最小真请求,返回 {ok,status,latencyMs,err}。
func (a *App) LocalGatewayConnTest() (gateway.ConnTestResult, error) {
	if err := ensureLocal(); err != nil {
		return gateway.ConnTestResult{}, err
	}
	return localHub.GatewayConnTest(), nil
}

package main

import "bcai-wails/internal/local/modelprovider"

// 自定义模型供应商(codex OpenAI 兼容供应商)+ 动态模型目录 Wails 绑定 ——
// 独立文件,只薄薄委托给 hub。红线:自定义供应商喂号路径,不碰远程租号 / proxy.go。

// LocalListModelProviders 列出全部自定义模型供应商。
func (a *App) LocalListModelProviders() ([]modelprovider.Provider, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListModelProviders(), nil
}

// LocalSaveModelProvider 新增/更新一条供应商(按 id upsert),返回落盘后的记录。
func (a *App) LocalSaveModelProvider(p modelprovider.Provider) (modelprovider.Provider, error) {
	if err := ensureLocal(); err != nil {
		return modelprovider.Provider{}, err
	}
	return localHub.SaveModelProvider(p)
}

// LocalDeleteModelProvider 按 id 删除一条供应商(幂等)。
func (a *App) LocalDeleteModelProvider(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.DeleteModelProvider(id)
}

// LocalTestModelProvider 对某供应商 /models 端点发最小真请求,返回连通结果。
func (a *App) LocalTestModelProvider(id string) (modelprovider.ConnTestResult, error) {
	if err := ensureLocal(); err != nil {
		return modelprovider.ConnTestResult{}, err
	}
	return localHub.TestModelProvider(id)
}

// LocalListModelProviderModels 拉某供应商动态模型目录(并回写到 provider.ModelCatalog)。
func (a *App) LocalListModelProviderModels(id string) (modelprovider.ListModelsResult, error) {
	if err := ensureLocal(); err != nil {
		return modelprovider.ListModelsResult{}, err
	}
	return localHub.ListModelProviderModels(id)
}

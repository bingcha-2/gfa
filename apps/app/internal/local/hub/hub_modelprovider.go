package hub

import "bcai-wails/internal/local/modelprovider"

// 自定义模型供应商(codex OpenAI 兼容供应商)+ 动态模型目录 —— 薄委托给 modelprovider.Store。
// 红线:这是自定义供应商喂号路径,与远程租号无关;不碰 proxy.go。

// ListModelProviders 返回全部自定义模型供应商(按 createdAt 升序)。
func (h *Hub) ListModelProviders() []modelprovider.Provider { return h.modelProv.List() }

// SaveModelProvider 新增/更新一条供应商(按 id upsert),返回落盘后的记录。
func (h *Hub) SaveModelProvider(p modelprovider.Provider) (modelprovider.Provider, error) {
	return h.modelProv.Save(p)
}

// DeleteModelProvider 按 id 删除一条供应商(幂等)。
func (h *Hub) DeleteModelProvider(id string) error { return h.modelProv.Delete(id) }

// TestModelProvider 对某供应商的 /models 端点发最小真请求,返回连通结果。
func (h *Hub) TestModelProvider(id string) (modelprovider.ConnTestResult, error) {
	p, ok := h.modelProv.Get(id)
	if !ok {
		return modelprovider.ConnTestResult{}, errProviderNotFound(id)
	}
	return modelprovider.TestConnection(p, nil), nil
}

// ListModelProviderModels 拉某供应商动态模型目录并回写到 provider.ModelCatalog。
func (h *Hub) ListModelProviderModels(id string) (modelprovider.ListModelsResult, error) {
	p, ok := h.modelProv.Get(id)
	if !ok {
		return modelprovider.ListModelsResult{}, errProviderNotFound(id)
	}
	res, err := modelprovider.ListModels(p, nil)
	if err != nil {
		return modelprovider.ListModelsResult{}, err
	}
	ids := make([]string, 0, len(res.Models))
	for _, m := range res.Models {
		ids = append(ids, m.ID)
	}
	// 回写目录;回写失败不影响已拉到的结果返回。
	_ = h.modelProv.SetModelCatalog(id, ids)
	return res, nil
}

func errProviderNotFound(id string) error { return &providerNotFoundError{id: id} }

type providerNotFoundError struct{ id string }

func (e *providerNotFoundError) Error() string { return "hub: 模型供应商不存在: " + e.id }

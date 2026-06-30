package hub

import (
	"bcai-wails/internal/local/datatransfer"
	"bcai-wails/internal/local/instance"
)

// 数据迁移 bundle 的薄绑定:把「实例库 + 各配置 store」摊平进 datatransfer.Snapshot,
// 反向把导入的 snapshot 回灌实例库与配置。
//
// datatransfer 是自包含纯逻辑包(版本化信封 + 运行态清理),用本包自有的 InstanceProfile
// 与开放 Config map,store 类型演进不破坏 bundle 格式。本文件负责字段搬运。
//
// 红线:只打包/还原本地配置与实例库,绝不导出 token 出口路径 / 远程租号。

// configKey* 是 Config 开放袋里 hub 负责搬运的已知键(camelCase,前端可直读 bundle)。
const (
	configKeyRoutingStrategy    = "routingStrategy"
	configKeyGatewayAccessScope = "gatewayAccessScope"
)

// ExportDataBundle 导出「配置 + 实例库」为版本化 JSON bundle(字节)。
func (h *Hub) ExportDataBundle() ([]byte, error) {
	snap := h.buildSnapshot()
	return datatransfer.Export(snap)
}

// ImportDataBundle 从 bundle 还原:替换实例库、回灌已知配置,返回导入的实例数。
func (h *Hub) ImportDataBundle(data []byte) (int, error) {
	snap, err := datatransfer.Import(data)
	if err != nil {
		return 0, err
	}
	if err := h.applySnapshot(snap); err != nil {
		return 0, err
	}
	return len(snap.Instances), nil
}

// buildSnapshot 收集实例库 + 已知配置成内存快照。
func (h *Hub) buildSnapshot() datatransfer.Snapshot {
	var insts []datatransfer.InstanceProfile
	for _, p := range h.instances.All() {
		insts = append(insts, instanceToBundle(p))
	}
	cfg := map[string]any{
		configKeyRoutingStrategy:    h.GetRoutingStrategy(),
		configKeyGatewayAccessScope: h.GetGatewayAccessScope(),
	}
	return datatransfer.Snapshot{Config: cfg, Instances: insts}
}

// applySnapshot 用快照替换实例库,并回灌可识别的配置(无法识别的键忽略)。
func (h *Hub) applySnapshot(snap datatransfer.Snapshot) error {
	bundleProfiles := make([]*instance.Profile, 0, len(snap.Instances))
	for _, b := range snap.Instances {
		bundleProfiles = append(bundleProfiles, bundleToInstance(b))
	}
	if err := h.instances.Replace(bundleProfiles); err != nil {
		return err
	}
	if v, ok := snap.Config[configKeyRoutingStrategy].(string); ok && v != "" {
		_ = h.SetRoutingStrategy(v)
	}
	if v, ok := snap.Config[configKeyGatewayAccessScope].(string); ok && v != "" {
		_ = h.SetGatewayAccessScope(v)
	}
	return nil
}

func instanceToBundle(p *instance.Profile) datatransfer.InstanceProfile {
	return datatransfer.InstanceProfile{
		ID: p.ID, Provider: p.Provider, Name: p.Name, UserDataDir: p.UserDataDir,
		WorkingDir: p.WorkingDir, ExtraArgs: p.ExtraArgs, BindAccountID: p.BindAccountID,
		CreatedAt: p.CreatedAt, LastLaunchedAt: p.LastLaunchedAt, Pid: p.Pid,
	}
}

func bundleToInstance(b datatransfer.InstanceProfile) *instance.Profile {
	return &instance.Profile{
		ID: b.ID, Provider: b.Provider, Name: b.Name, UserDataDir: b.UserDataDir,
		WorkingDir: b.WorkingDir, ExtraArgs: b.ExtraArgs, BindAccountID: b.BindAccountID,
		CreatedAt: b.CreatedAt, LastLaunchedAt: b.LastLaunchedAt, Pid: b.Pid,
	}
}

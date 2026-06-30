// Package datatransfer 把本地接管的「配置 + 实例库」打包成一个版本化 JSON bundle
// (Export)并从 bundle 还原(Import),用于备份/迁移到另一台机器。
//
// 对齐 cockpit 的 data_transfer_*(get/apply user config、get/replace instance
// store):同样按版本+schema 封装,导入时清掉运行态字段(pid/lastLaunchedAt),
// 避免把本机进程状态带到目标机器。
//
// 本包自包含且可独立 go test:
//   - 不导入兄弟包(account/instance/...);用本包自带的 InstanceProfile/map 快照,
//     由调用方在 hub 层做与具体 store 的字段搬运(薄绑定),这样 store 类型演进不会
//     破坏 bundle 格式。
//   - 纯函数 Export/Import([]byte ↔ Snapshot);文件 IO 是薄封装,用临时目录测。
//   - 绝不触碰 proxy.go / 远程租号路径。
package datatransfer

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Schema 标识 bundle 类型;Import 时严格校验,杜绝误把别的 JSON 当成本地备份。
const Schema = "bcai.local.data-transfer"

// Version 是 bundle 结构版本。结构不兼容变更时递增,Import 拒绝未知版本
// (而非静默错读),由调用方决定迁移策略。
const Version = 1

// InstanceProfile 是 bundle 内的实例快照。字段对齐 instance.Profile,但在本包内
// 自有一份,使 bundle 格式与 store 实现解耦。运行态字段(LastLaunchedAt/Pid)会被
// Export 原样写出、Import 主动清零(见 sanitizeInstance)。
type InstanceProfile struct {
	ID             string `json:"id"`
	Provider       string `json:"provider"`
	Name           string `json:"name"`
	UserDataDir    string `json:"userDataDir"`
	WorkingDir     string `json:"workingDir,omitempty"`
	ExtraArgs      string `json:"extraArgs,omitempty"`
	BindAccountID  string `json:"bindAccountId,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	LastLaunchedAt int64  `json:"lastLaunchedAt,omitempty"`
	Pid            int    `json:"pid,omitempty"`
}

// Snapshot 是一次「配置 + 实例库」的内存快照,Export 的输入 / Import 的输出。
// Config 是开放的 key→value 配置袋(language / 各 cfg store 的值),保持开放是为了
// 新增配置项时无需改 bundle 结构;调用方负责把具体 store 摊平进/还原出此 map。
type Snapshot struct {
	Config    map[string]any    `json:"config"`
	Instances []InstanceProfile `json:"instances"`
}

// bundle 是落盘/传输的版本化信封。
type bundle struct {
	Schema     string   `json:"schema"`
	Version    int      `json:"version"`
	ExportedAt string   `json:"exportedAt"`
	Snapshot   Snapshot `json:"snapshot"`
}

// Export 把快照编码成版本化 JSON bundle(纯函数,不碰磁盘)。
func Export(s Snapshot) ([]byte, error) {
	b := bundle{
		Schema:     Schema,
		Version:    Version,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Snapshot:   normalize(s),
	}
	return json.MarshalIndent(b, "", "  ")
}

// Import 解析 bundle 并还原快照(纯函数,不碰磁盘)。
// 严格校验 schema/version,并清除实例运行态字段(pid/lastLaunchedAt)。
func Import(data []byte) (Snapshot, error) {
	var b bundle
	if err := json.Unmarshal(data, &b); err != nil {
		return Snapshot{}, fmt.Errorf("datatransfer: invalid bundle json: %w", err)
	}
	if b.Schema != Schema {
		return Snapshot{}, fmt.Errorf("datatransfer: unexpected schema %q (want %q)", b.Schema, Schema)
	}
	if b.Version != Version {
		return Snapshot{}, fmt.Errorf("datatransfer: unsupported bundle version %d (want %d)", b.Version, Version)
	}
	out := normalize(b.Snapshot)
	for i := range out.Instances {
		out.Instances[i] = sanitizeInstance(out.Instances[i])
	}
	return out, nil
}

// ExportFile 把快照原子写到 path(.tmp + rename),用临时目录测。
func ExportFile(path string, s Snapshot) error {
	data, err := Export(s)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ImportFile 从 path 读取并解析 bundle。
func ImportFile(path string) (Snapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Snapshot{}, err
	}
	return Import(data)
}

// normalize 保证 nil map/slice 落地成空容器,使消费端无需判 nil。
func normalize(s Snapshot) Snapshot {
	if s.Config == nil {
		s.Config = map[string]any{}
	}
	if s.Instances == nil {
		s.Instances = []InstanceProfile{}
	}
	return s
}

// sanitizeInstance 清掉本机运行态,避免跨机器还原后误判进程在运行。
func sanitizeInstance(p InstanceProfile) InstanceProfile {
	p.Pid = 0
	p.LastLaunchedAt = 0
	return p
}

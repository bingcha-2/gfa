// Package sessionsync 提供 codex 跨实例会话的纯逻辑:跨实例列会话、移入回收站、
// 从回收站恢复、token 统计。移植自 cockpit
// crates/cockpit-core/src/modules/codex_session_manager.rs(list/moveToTrash/
// restoreFromTrash/tokenStats)。
//
// 设计取舍(相对 cockpit):
//   - 实例集合由调用方传入([]Instance,各带 user-data-dir 与 running 标记),
//     本包不做 collect_instances / 进程探测,便于用临时目录单测。
//   - 废纸篓根目录由调用方传入(trashRoot),不读 ~/.Trash 或 app 数据目录。
//   - 不触发官方 Codex 重建会话索引(rebuild_thread_metadata):那是编排/平台职责,
//     由 hub 在调用本包后自行处理。本包只保证 rollout 文件与 session_index.jsonl 一致。
//
// 会话文件布局(每个实例 DataDir 下):
//   - sessions/.../rollout-*.jsonl、archived_sessions/.../rollout-*.jsonl:每会话一份,
//     首行是 session_meta(含 id/cwd)。
//   - session_index.jsonl:每行一条会话元数据(id/thread_name/updated_at)。
package sessionsync

// Instance 一个 codex 实例:user-data-dir + 展示名 + 运行态(由调用方判定)。
type Instance struct {
	ID      string
	Name    string
	DataDir string
	Running bool
}

// SearchFilter 列会话时的过滤条件(均为空表示不过滤)。
type SearchFilter struct {
	TitleQuery   string // 大小写不敏感,匹配会话标题。
	ContentQuery string // 在 rollout 原文里做子串匹配(ASCII 大小写不敏感)。
}

// SessionLocation 一条会话在某个实例中的落点。
type SessionLocation struct {
	InstanceID   string `json:"instanceId"`
	InstanceName string `json:"instanceName"`
	Running      bool   `json:"running"`
}

// SessionRecord 一条跨实例去重后的会话。
type SessionRecord struct {
	SessionID     string            `json:"sessionId"`
	Title         string            `json:"title"`
	Cwd           string            `json:"cwd"`
	UpdatedAt     *int64            `json:"updatedAt"` // unix 秒;nil 表示未知。
	LocationCount int               `json:"locationCount"`
	Locations     []SessionLocation `json:"locations"`
}

// SessionTokenStats 一条会话的累计 token 用量(取 rollout 最后一条 token_count)。
type SessionTokenStats struct {
	SessionID    string `json:"sessionId"`
	InputTokens  uint64 `json:"inputTokens"`
	OutputTokens uint64 `json:"outputTokens"`
	TotalTokens  uint64 `json:"totalTokens"`
}

// TrashSummary 移入废纸篓的结果汇总。
type TrashSummary struct {
	RequestedSessionCount int    `json:"requestedSessionCount"`
	TrashedSessionCount   int    `json:"trashedSessionCount"`
	TrashedInstanceCount  int    `json:"trashedInstanceCount"`
	TrashDir              string `json:"trashDir"`
	Message               string `json:"message"`
}

// TrashedSessionLocation 废纸篓中一条会话曾经的实例落点。
type TrashedSessionLocation struct {
	InstanceID   string `json:"instanceId"`
	InstanceName string `json:"instanceName"`
}

// TrashedSessionRecord 废纸篓中去重后的一条会话。
type TrashedSessionRecord struct {
	SessionID     string                   `json:"sessionId"`
	Title         string                   `json:"title"`
	Cwd           string                   `json:"cwd"`
	DeletedAt     *int64                   `json:"deletedAt"` // unix 秒;nil 表示未知。
	LocationCount int                      `json:"locationCount"`
	Locations     []TrashedSessionLocation `json:"locations"`
}

// RestoreSummary 从废纸篓恢复的结果汇总。
type RestoreSummary struct {
	RequestedSessionCount int    `json:"requestedSessionCount"`
	RestoredSessionCount  int    `json:"restoredSessionCount"`
	RestoredInstanceCount int    `json:"restoredInstanceCount"`
	Message               string `json:"message"`
}

// ── 跨实例同步 / 可见性修复(Wave N)——移植自 cockpit
//    codex_thread_sync.rs(sync_sessions_to_instance / sync_threads_across_instances)
//    与 codex_session_visibility.rs(repair_session_visibility_across_instances)。
//
// 设计取舍(相对 cockpit):本包只做纯文件系统层的一致性维护 —— 复制/去重 rollout、
// 补齐 session_index、按目标 provider 校正 session_meta。SQLite state DB 重写、
// 官方索引重建(rebuild_thread_metadata)属平台/编排职责,不在本包(便于临时目录单测)。

// SyncToInstanceSummary 把若干会话恢复到目标实例的结果汇总。
type SyncToInstanceSummary struct {
	RequestedSessionCount int    `json:"requestedSessionCount"`
	TargetInstanceID      string `json:"targetInstanceId"`
	TargetInstanceName    string `json:"targetInstanceName"`
	SyncedSessionCount    int    `json:"syncedSessionCount"`
	SkippedExistingCount  int    `json:"skippedExistingCount"`
	MissingSessionCount   int    `json:"missingSessionCount"`
	Running               bool   `json:"running"`
	Message               string `json:"message"`
}

// ThreadSyncItem 跨实例线程同步中,单个实例的落地统计。
type ThreadSyncItem struct {
	InstanceID         string `json:"instanceId"`
	InstanceName       string `json:"instanceName"`
	AddedThreadCount   int    `json:"addedThreadCount"`
	UpdatedThreadCount int    `json:"updatedThreadCount"`
}

// ThreadSyncSummary 跨实例线程去重/对齐的结果汇总。
type ThreadSyncSummary struct {
	InstanceCount          int              `json:"instanceCount"`
	ThreadUniverseCount    int              `json:"threadUniverseCount"`
	MutatedInstanceCount   int              `json:"mutatedInstanceCount"`
	TotalSyncedThreadCount int              `json:"totalSyncedThreadCount"`
	TotalAddedThreadCount  int              `json:"totalAddedThreadCount"`
	Items                  []ThreadSyncItem `json:"items"`
	Message                string           `json:"message"`
}

// VisibilityRepairItem 单实例可见性修复统计。
type VisibilityRepairItem struct {
	InstanceID              string `json:"instanceId"`
	InstanceName            string `json:"instanceName"`
	TargetProvider          string `json:"targetProvider"`
	ChangedRolloutFileCount int    `json:"changedRolloutFileCount"`
	Running                 bool   `json:"running"`
}

// VisibilityRepairSummary 跨实例可见性修复的结果汇总。
type VisibilityRepairSummary struct {
	InstanceCount           int                    `json:"instanceCount"`
	MutatedInstanceCount    int                    `json:"mutatedInstanceCount"`
	ChangedRolloutFileCount int                    `json:"changedRolloutFileCount"`
	Items                   []VisibilityRepairItem `json:"items"`
	Message                 string                 `json:"message"`
}

// RepairInstanceOption 可见性修复时的候选实例(带当前 provider)。
type RepairInstanceOption struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	UserDataDir     string `json:"userDataDir"`
	CurrentProvider string `json:"currentProvider"`
	Running         bool   `json:"running"`
}

// RepairProviderOption 一个候选 provider 及其来源(config / rollout)。
type RepairProviderOption struct {
	ID        string   `json:"id"`
	Sources   []string `json:"sources"`
	IsDefault bool     `json:"isDefault"`
}

// RepairProviderList 可见性修复的候选 provider 汇总。
type RepairProviderList struct {
	DefaultProvider string                 `json:"defaultProvider"`
	Providers       []RepairProviderOption `json:"providers"`
}

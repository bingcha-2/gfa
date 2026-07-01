package hub

import (
	"path/filepath"

	"bcai-wails/internal/local/codexsettings"
	"bcai-wails/internal/local/sessionsync"
)

// codex 跨实例会话管理的薄委托:把实例库映射成 sessionsync.Instance(各带 DataDir + Running),
// 废纸篓根目录固定在 hub 数据目录下 codex-session-trash。
//
// sessionsync 是自包含纯逻辑包(实例集合 + trashRoot 由调用方注入),本文件负责注入。
// 注:本包不触发官方 Codex 重建索引(rebuild_thread_metadata),那属平台职责;
// 这里仅保证 rollout 与 session_index.jsonl 一致(由 sessionsync 内部维护)。
//
// 红线:只读写本地会话文件,与远程租号 / proxy.go / 网关出口无关。

// sessionInstances 返回会话来源:默认 Codex 主目录(~/.codex 或 CODEX_HOME)。
// (多实例管理已删,会话统一从默认 Codex 主目录读 rollout。)
func (h *Hub) sessionInstances() ([]sessionsync.Instance, error) {
	return []sessionsync.Instance{{
		ID:      "default",
		Name:    "Codex",
		DataDir: codexsettings.CodexHomeDir(),
	}}, nil
}

// sessionTrashRoot 是会话废纸篓根目录(hub 数据目录下,跨机器不可迁移的运行态)。
func (h *Hub) sessionTrashRoot() string { return filepath.Join(h.dir, "codex-session-trash") }

// ListSessions 跨实例去重列会话(可按标题/内容过滤)。
func (h *Hub) ListSessions(filter sessionsync.SearchFilter) ([]sessionsync.SessionRecord, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return nil, err
	}
	return sessionsync.ListSessions(insts, filter)
}

// SessionTokenStats 统计若干会话的累计 token 用量。
func (h *Hub) SessionTokenStats(sessionIDs []string) ([]sessionsync.SessionTokenStats, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return nil, err
	}
	return sessionsync.TokenStats(insts, sessionIDs)
}

// MoveSessionsToTrash 把若干会话移入废纸篓,返回汇总。
func (h *Hub) MoveSessionsToTrash(sessionIDs []string) (sessionsync.TrashSummary, error) {
	insts, err := h.sessionInstances()
	if err != nil {
		return sessionsync.TrashSummary{}, err
	}
	return sessionsync.MoveToTrash(insts, sessionIDs, h.sessionTrashRoot())
}

// ListTrashedSessions 列废纸篓中的会话。
func (h *Hub) ListTrashedSessions() ([]sessionsync.TrashedSessionRecord, error) {
	return sessionsync.ListTrashed(h.sessionTrashRoot())
}

// RestoreSessionsFromTrash 从废纸篓恢复若干会话,返回汇总。
func (h *Hub) RestoreSessionsFromTrash(sessionIDs []string) (sessionsync.RestoreSummary, error) {
	return sessionsync.RestoreFromTrash(sessionIDs, h.sessionTrashRoot())
}

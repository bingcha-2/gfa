package main

import "bcai-wails/internal/local/sessionsync"

// codex 跨实例会话管理 Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:只读写本地会话文件,不碰远程租号 / proxy.go / 网关出口。

func (a *App) LocalListCodexSessions(titleQuery, contentQuery string) ([]sessionsync.SessionRecord, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListSessions(sessionsync.SearchFilter{TitleQuery: titleQuery, ContentQuery: contentQuery})
}

func (a *App) LocalCodexSessionTokenStats(sessionIDs []string) ([]sessionsync.SessionTokenStats, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.SessionTokenStats(sessionIDs)
}

func (a *App) LocalMoveCodexSessionsToTrash(sessionIDs []string) (sessionsync.TrashSummary, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.TrashSummary{}, err
	}
	return localHub.MoveSessionsToTrash(sessionIDs)
}

func (a *App) LocalListTrashedCodexSessions() ([]sessionsync.TrashedSessionRecord, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListTrashedSessions()
}

func (a *App) LocalRestoreCodexSessionsFromTrash(sessionIDs []string) (sessionsync.RestoreSummary, error) {
	if err := ensureLocal(); err != nil {
		return sessionsync.RestoreSummary{}, err
	}
	return localHub.RestoreSessionsFromTrash(sessionIDs)
}

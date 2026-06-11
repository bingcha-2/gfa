package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ─── Codex 历史会话可见性修复(自愈旧版污染)──────────────────────────────────
//
// Codex 桌面端按 model_provider 给历史会话/项目分桶展示:rollout-*.jsonl 首行的
// session_meta.payload.model_provider,以及 state_5.sqlite 的 threads 表
// model_provider 列。
//
// 新接管模式(只改 chatgpt_base_url、不改 provider)不会再造成历史消失。但**旧版
// GFA** 曾把 provider 改成 bingchaai,污染了历史元数据,导致升级前接管过的用户历史
// 在官方视图(provider=openai)下消失。本模块把这些元数据自愈回 openai。

const codexStateDBFile = "state_5.sqlite"

var codexSessionDirs = []string{"sessions", "archived_sessions"}

// HistoryVisibilitySummary 修复结果摘要。
type HistoryVisibilitySummary struct {
	TargetProvider     string `json:"targetProvider"`
	ChangedRolloutFile int    `json:"changedRolloutFiles"`
	UpdatedSQLiteRows  int    `json:"updatedSqliteRows"`
	SkippedSQLite      bool   `json:"skippedSqlite"`
}

// AlignCodexHistoryVisibility 把指定 codex home 下的历史会话 provider 元数据对齐到
// targetProvider。尽力而为:单个文件/数据库失败不会中断整体。
func AlignCodexHistoryVisibility(home, targetProvider string) (HistoryVisibilitySummary, error) {
	target := strings.TrimSpace(targetProvider)
	if target == "" {
		target = codexDefaultProvider
	}
	summary := HistoryVisibilitySummary{TargetProvider: target}

	changed, err := alignRolloutProviders(home, target)
	summary.ChangedRolloutFile = changed
	if err != nil {
		Log("[codex] rollout 可见性修复部分失败: %v", err)
	}

	rows, skipped, sqlErr := alignSQLiteProviders(home, target)
	summary.UpdatedSQLiteRows = rows
	summary.SkippedSQLite = skipped
	if sqlErr != nil {
		Log("[codex] state_5.sqlite 可见性修复失败: %v", sqlErr)
	}

	return summary, nil
}

// alignRolloutProviders 遍历 rollout-*.jsonl,改写首行 session_meta 的 model_provider。
func alignRolloutProviders(home, target string) (int, error) {
	changed := 0
	var firstErr error
	for _, dirName := range codexSessionDirs {
		root := filepath.Join(home, dirName)
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil // 跳过不可读项,继续遍历
			}
			if d.IsDir() {
				return nil
			}
			name := d.Name()
			if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				return nil
			}
			ok, err := retagRolloutFile(path, target)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return nil
			}
			if ok {
				changed++
			}
			return nil
		})
	}
	return changed, firstErr
}

// retagRolloutFile 读取首行,若 session_meta.payload.model_provider != target 则改写,
// 保留其余内容与文件 mtime(避免扰动 Codex 的排序)。返回是否发生改写。
func retagRolloutFile(path, target string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}

	// 切出首行内容、换行符、剩余内容(保留 LF/CRLF 风格)。
	firstLine, separator, rest := splitFirstLine(data)

	trimmed := strings.TrimSpace(string(firstLine))
	if trimmed == "" {
		return false, nil
	}
	var rec map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &rec); err != nil {
		return false, nil // 非 JSON 首行,跳过
	}
	if t, _ := rec["type"].(string); t != "session_meta" {
		return false, nil
	}
	payload, ok := rec["payload"].(map[string]interface{})
	if !ok {
		return false, nil
	}
	if cur, _ := payload["model_provider"].(string); cur == target {
		return false, nil
	}
	payload["model_provider"] = target
	rec["payload"] = payload

	newFirst, err := json.Marshal(rec)
	if err != nil {
		return false, err
	}

	// 保留 CRLF/LF:沿用原换行风格,后续行原样保留。
	out := make([]byte, 0, len(newFirst)+len(separator)+len(rest))
	out = append(out, newFirst...)
	out = append(out, separator...)
	out = append(out, rest...)

	// 记录并在写后恢复 mtime,避免改写打乱按修改时间排序的历史列表。
	mtime := fileModTime(path)
	if err := writeFileAtomic(path, out, 0o644); err != nil {
		return false, err
	}
	if !mtime.IsZero() {
		_ = os.Chtimes(path, mtime, mtime)
	}
	return true, nil
}

// alignSQLiteProviders 更新 state_5.sqlite 的 threads.model_provider 等列。
// 返回 (更新行数, 是否跳过无效库, error)。
func alignSQLiteProviders(home, target string) (int, bool, error) {
	dbPath := filepath.Join(home, codexStateDBFile)
	if _, err := os.Stat(dbPath); err != nil {
		return 0, false, nil // 没有数据库,无需处理
	}

	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(3000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return 0, true, fmt.Errorf("打开 state_5.sqlite 失败: %w", err)
	}
	defer db.Close()

	cols, err := threadsColumns(db)
	if err != nil {
		if isMissingThreadsTable(err) {
			return 0, false, nil
		}
		return 0, true, err
	}
	if len(cols) == 0 || !cols["model_provider"] {
		return 0, false, nil // 没有可对齐的列
	}

	setParts := []string{"model_provider = ?"}
	whereParts := []string{"COALESCE(model_provider, '') <> ?"}
	if cols["has_user_event"] && cols["first_user_message"] {
		setParts = append(setParts,
			"has_user_event = CASE WHEN COALESCE(first_user_message,'') <> '' THEN 1 ELSE has_user_event END")
		whereParts = append(whereParts,
			"(COALESCE(first_user_message,'') <> '' AND COALESCE(has_user_event,0) <> 1)")
	}
	if cols["thread_source"] && cols["first_user_message"] {
		setParts = append(setParts,
			"thread_source = CASE WHEN COALESCE(thread_source,'')='' AND COALESCE(first_user_message,'')<>'' THEN 'user' ELSE thread_source END")
		whereParts = append(whereParts,
			"(COALESCE(first_user_message,'') <> '' AND COALESCE(thread_source,'') = '')")
	}

	query := fmt.Sprintf("UPDATE threads SET %s WHERE %s",
		strings.Join(setParts, ", "), strings.Join(whereParts, " OR "))
	res, err := db.Exec(query, target, target)
	if err != nil {
		if isMissingThreadsTable(err) {
			return 0, false, nil
		}
		return 0, true, fmt.Errorf("更新 threads provider 失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), false, nil
}

// threadsColumns 返回 threads 表的列集合。
func threadsColumns(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(threads)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt interface{}
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

func isMissingThreadsTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table: threads")
}

// fileModTime 返回文件 mtime,失败返回零值。
func fileModTime(path string) time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// splitFirstLine 把内容切成 (首行内容, 换行符, 剩余)。无换行时换行符与剩余为空。
func splitFirstLine(data []byte) (first, separator, rest []byte) {
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			if i > 0 && data[i-1] == '\r' {
				return data[:i-1], data[i-1 : i+1], data[i+1:]
			}
			return data[:i], data[i : i+1], data[i+1:]
		}
	}
	return data, nil, nil
}

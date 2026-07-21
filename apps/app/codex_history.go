package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
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
// 远程接管使用 bingchaai provider,官方/本地账号通常使用 openai。
// 切换后必须在 Codex 启动前把 rollout 和 SQLite 同时对齐到当前
// provider,否则旧会话会继续使用切换前的路由/账号。

const codexStateDBFile = "state_5.sqlite"

var codexSessionDirs = []string{"sessions", "archived_sessions"}

// codexStateDBPaths 同时覆盖 Codex 历史版本的根目录布局和新版官方
// sqlite/ 布局。Cockpit 启动前修复也会同时检查这两个位置。
func codexStateDBPaths(home string) []string {
	return []string{
		filepath.Join(home, "sqlite", codexStateDBFile),
		filepath.Join(home, codexStateDBFile),
	}
}

// HistoryVisibilitySummary 修复结果摘要。
type HistoryVisibilitySummary struct {
	TargetProvider     string `json:"targetProvider"`
	ChangedRolloutFile int    `json:"changedRolloutFiles"`
	UpdatedSQLiteRows  int    `json:"updatedSqliteRows"`
	SkippedSQLite      bool   `json:"skippedSqlite"`
}

func MigrateCodexHistoryProvider(home, sourceProvider, targetProvider string) (HistoryVisibilitySummary, error) {
	source := strings.TrimSpace(sourceProvider)
	target := strings.TrimSpace(targetProvider)
	if target == "" {
		target = codexDefaultProvider
	}
	summary := HistoryVisibilitySummary{TargetProvider: target}
	if source == "" || source == target {
		return summary, nil
	}

	changed, err := rewriteRolloutProviders(home, source, target)
	summary.ChangedRolloutFile = changed
	if err != nil {
		Log("[codex] rollout provider 迁移部分失败: %v", err)
	}
	rows, skipped, sqlErr := migrateSQLiteProvider(home, source, target)
	summary.UpdatedSQLiteRows = rows
	summary.SkippedSQLite = skipped
	if sqlErr != nil {
		Log("[codex] state_5.sqlite provider 迁移失败: %v", sqlErr)
	}
	return summary, nil
}

// AlignCodexHistoryVisibility 把指定 codex home 下的历史会话 provider 元数据对齐到
// targetProvider。尽力而为:单个文件/数据库失败不会中断整体。
func AlignCodexHistoryVisibility(home, targetProvider string) (HistoryVisibilitySummary, error) {
	target := strings.TrimSpace(targetProvider)
	if target == "" {
		target = codexDefaultProvider
	}
	summary := HistoryVisibilitySummary{TargetProvider: target}
	var repairErrors []error

	changed, err := alignRolloutProviders(home, target)
	summary.ChangedRolloutFile = changed
	if err != nil {
		Log("[codex] rollout 可见性修复部分失败: %v", err)
		repairErrors = append(repairErrors, err)
	}

	rows, skipped, sqlErr := alignSQLiteProviders(home, target)
	summary.UpdatedSQLiteRows = rows
	summary.SkippedSQLite = skipped
	if sqlErr != nil {
		Log("[codex] state_5.sqlite 可见性修复失败: %v", sqlErr)
		repairErrors = append(repairErrors, sqlErr)
	}

	return summary, errors.Join(repairErrors...)
}

// alignRolloutProviders 遍历 rollout-*.jsonl,改写所有 session_meta 的 model_provider。
func alignRolloutProviders(home, target string) (int, error) {
	return rewriteRolloutProviders(home, "", target)
}

func rewriteRolloutProviders(home, source, target string) (int, error) {
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
			ok, err := retagRolloutFileFrom(path, source, target)
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

// retagRolloutFile 改写文件中所有 session_meta。Codex 在会话分支/恢复后可能追加
// 多条 session_meta,只改首行会让旧 provider 在继续会话时再次生效。
// 保留非 session_meta 行、原换行符与文件 mtime(避免扰动 Codex 排序)。
func retagRolloutFile(path, target string) (bool, error) {
	return retagRolloutFileFrom(path, "", target)
}

func retagRolloutFileFrom(path, source, target string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	segments := bytes.SplitAfter(data, []byte{'\n'})
	var out bytes.Buffer
	out.Grow(len(data))
	changed := false
	for _, segment := range segments {
		if len(segment) == 0 {
			continue
		}
		line := segment
		ending := []byte(nil)
		if bytes.HasSuffix(line, []byte("\r\n")) {
			line = line[:len(line)-2]
			ending = []byte("\r\n")
		} else if bytes.HasSuffix(line, []byte("\n")) {
			line = line[:len(line)-1]
			ending = []byte("\n")
		}

		trimmed := bytes.TrimSpace(line)
		var rec map[string]interface{}
		if len(trimmed) == 0 || json.Unmarshal(trimmed, &rec) != nil {
			out.Write(line)
			out.Write(ending)
			continue
		}
		if recordType, _ := rec["type"].(string); recordType != "session_meta" {
			out.Write(line)
			out.Write(ending)
			continue
		}
		payload, ok := rec["payload"].(map[string]interface{})
		if !ok {
			out.Write(line)
			out.Write(ending)
			continue
		}
		cur, _ := payload["model_provider"].(string)
		if cur == target || (source != "" && cur != source) {
			out.Write(line)
			out.Write(ending)
			continue
		}
		payload["model_provider"] = target
		rec["payload"] = payload
		rewritten, marshalErr := json.Marshal(rec)
		if marshalErr != nil {
			return false, marshalErr
		}
		out.Write(rewritten)
		out.Write(ending)
		changed = true
	}
	if !changed {
		return false, nil
	}

	// 记录并在写后恢复 mtime,避免改写打乱按修改时间排序的历史列表。
	mtime := fileModTime(path)
	if err := writeFileAtomic(path, out.Bytes(), 0o644); err != nil {
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
	totalRows := 0
	skippedAny := false
	var repairErrors []error
	for _, dbPath := range codexStateDBPaths(home) {
		rows, skipped, err := alignSQLiteProviderDB(dbPath, target)
		totalRows += rows
		skippedAny = skippedAny || skipped
		if err != nil {
			repairErrors = append(repairErrors, err)
		}
	}
	return totalRows, skippedAny, errors.Join(repairErrors...)
}

func alignSQLiteProviderDB(dbPath, target string) (int, bool, error) {
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

func migrateSQLiteProvider(home, source, target string) (int, bool, error) {
	totalRows := 0
	skippedAny := false
	var repairErrors []error
	for _, dbPath := range codexStateDBPaths(home) {
		rows, skipped, err := migrateSQLiteProviderDB(dbPath, source, target)
		totalRows += rows
		skippedAny = skippedAny || skipped
		if err != nil {
			repairErrors = append(repairErrors, err)
		}
	}
	return totalRows, skippedAny, errors.Join(repairErrors...)
}

func migrateSQLiteProviderDB(dbPath, source, target string) (int, bool, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return 0, false, nil
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
	if !cols["model_provider"] {
		return 0, false, nil
	}
	res, err := db.Exec(
		"UPDATE threads SET model_provider = ? WHERE COALESCE(model_provider, '') = ?",
		target,
		source,
	)
	if err != nil {
		return 0, true, fmt.Errorf("迁移 threads provider 失败: %w", err)
	}
	rows, _ := res.RowsAffected()
	return int(rows), false, nil
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

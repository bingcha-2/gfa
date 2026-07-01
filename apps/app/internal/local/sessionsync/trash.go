package sessionsync

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// trashManifest 废纸篓中每条会话的 manifest.json,保留恢复所需的全部信息。
type trashManifest struct {
	SessionID           string          `json:"sessionId"`
	Title               string          `json:"title"`
	Cwd                 string          `json:"cwd"`
	InstanceID          string          `json:"instanceId"`
	InstanceName        string          `json:"instanceName"`
	InstanceRoot        string          `json:"instanceRoot"`
	OriginalRolloutPath string          `json:"originalRolloutPath"`
	RelativeRolloutPath string          `json:"relativeRolloutPath"`
	SessionIndexEntry   json.RawMessage `json:"sessionIndexEntry"`
	DeletedAt           string          `json:"deletedAt"` // RFC3339。
}

// trashEntry 废纸篓里一条解析好的条目(manifest + 实际文件路径)。
type trashEntry struct {
	entryDir           string
	manifest           trashManifest
	trashedRolloutPath string
}

// MoveToTrash 把指定会话从各实例移入废纸篓:迁走 rollout 文件、从 session_index 摘除条目,
// 并在 trashRoot 下保存 manifest 供恢复。trashRoot 由调用方提供(便于单测用临时目录)。
func MoveToTrash(instances []Instance, sessionIDs []string, trashRoot string) (TrashSummary, error) {
	requested := dedupeTrimmed(sessionIDs)
	if len(requested) == 0 {
		return TrashSummary{}, errors.New("sessionsync: 请至少选择一条会话")
	}

	batchDir := filepath.Join(trashRoot, time.Now().UTC().Format("20060102-150405"))
	if err := os.MkdirAll(batchDir, 0o755); err != nil {
		return TrashSummary{}, fmt.Errorf("sessionsync: 创建废纸篓批次目录失败 (%s): %w", batchDir, err)
	}

	trashedIDs := map[string]bool{}
	trashedInstances := 0
	for _, inst := range instances {
		snaps, err := loadThreadSnapshots(inst.DataDir)
		if err != nil {
			return TrashSummary{}, err
		}
		var picked []threadSnapshot
		for _, snap := range snaps {
			if requested[snap.id] {
				picked = append(picked, snap)
			}
		}
		if len(picked) == 0 {
			continue
		}
		for _, snap := range picked {
			if err := moveSnapshotToTrash(inst, batchDir, snap); err != nil {
				return TrashSummary{}, err
			}
			trashedIDs[snap.id] = true
		}
		if err := rewriteSessionIndexWithout(inst.DataDir, picked); err != nil {
			return TrashSummary{}, err
		}
		trashedInstances++
	}

	if trashedInstances == 0 {
		return TrashSummary{
			RequestedSessionCount: len(requested),
			Message:               "所选会话在当前实例集合中不存在，无需处理",
		}, nil
	}
	return TrashSummary{
		RequestedSessionCount: len(requested),
		TrashedSessionCount:   len(trashedIDs),
		TrashedInstanceCount:  trashedInstances,
		TrashDir:              batchDir,
		Message:               fmt.Sprintf("已将 %d 条会话移到废纸篓", len(trashedIDs)),
	}, nil
}

func moveSnapshotToTrash(inst Instance, batchDir string, snap threadSnapshot) error {
	if _, err := os.Stat(snap.rolloutPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	rel, err := filepath.Rel(snap.sourceRoot, snap.rolloutPath)
	if err != nil {
		rel = filepath.Base(snap.rolloutPath)
	}
	entryDir := filepath.Join(batchDir, fmt.Sprintf("%s--%s", sanitizeFileName(inst.ID), sanitizeFileName(snap.id)))
	fileTarget := filepath.Join(entryDir, "files", rel)
	if err := os.MkdirAll(filepath.Dir(fileTarget), 0o755); err != nil {
		return fmt.Errorf("sessionsync: 创建废纸篓会话目录失败 (%s): %w", filepath.Dir(fileTarget), err)
	}

	manifest := trashManifest{
		SessionID:           snap.id,
		Title:               snap.title,
		Cwd:                 snap.cwd,
		InstanceID:          inst.ID,
		InstanceName:        inst.Name,
		InstanceRoot:        inst.DataDir,
		OriginalRolloutPath: snap.rolloutPath,
		RelativeRolloutPath: rel,
		SessionIndexEntry:   snap.indexEntry,
		DeletedAt:           time.Now().UTC().Format(time.RFC3339),
	}
	mb, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("sessionsync: 序列化废纸篓清单失败: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(entryDir, "manifest.json"), append(mb, '\n')); err != nil {
		return fmt.Errorf("sessionsync: 写入废纸篓清单失败 (%s): %w", entryDir, err)
	}
	if err := os.Rename(snap.rolloutPath, fileTarget); err != nil {
		return fmt.Errorf("sessionsync: 移动会话文件到废纸篓失败 (%s -> %s): %w", snap.rolloutPath, fileTarget, err)
	}
	return nil
}

// rewriteSessionIndexWithout 重写 session_index.jsonl,剔除被删会话的行(保留其余行原文)。
func rewriteSessionIndexWithout(dataDir string, removed []threadSnapshot) error {
	path := filepath.Join(dataDir, sessionIndexFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	removedIDs := map[string]bool{}
	for _, s := range removed {
		removedIDs[s.id] = true
	}
	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var probe struct {
			ID string `json:"id"`
		}
		if json.Unmarshal([]byte(trimmed), &probe) == nil && removedIDs[probe.ID] {
			continue
		}
		kept = append(kept, trimmed)
	}
	out := ""
	if len(kept) > 0 {
		out = strings.Join(kept, "\n") + "\n"
	}
	return writeFileAtomic(path, []byte(out))
}

// ListTrashed 列出废纸篓中的会话(按 sessionId 去重)。trashRoot 由调用方提供。
func ListTrashed(trashRoot string) ([]TrashedSessionRecord, error) {
	entries, err := loadTrashEntries(trashRoot)
	if err != nil {
		return nil, err
	}
	byID := map[string]*TrashedSessionRecord{}
	for _, e := range entries {
		deletedAt := parseDeletedAt(e.manifest.DeletedAt)
		rec := byID[e.manifest.SessionID]
		if rec == nil {
			rec = &TrashedSessionRecord{
				SessionID: e.manifest.SessionID,
				Title:     e.manifest.Title,
				Cwd:       e.manifest.Cwd,
				DeletedAt: deletedAt,
			}
			byID[e.manifest.SessionID] = rec
		}
		if i64ptr(deletedAt) > i64ptr(rec.DeletedAt) {
			rec.DeletedAt = deletedAt
		}
		if strings.TrimSpace(rec.Title) == "" {
			rec.Title = e.manifest.Title
		}
		if strings.TrimSpace(rec.Cwd) == "" {
			rec.Cwd = e.manifest.Cwd
		}
		rec.Locations = append(rec.Locations, TrashedSessionLocation{
			InstanceID:   e.manifest.InstanceID,
			InstanceName: e.manifest.InstanceName,
		})
		rec.LocationCount = len(rec.Locations)
	}
	out := make([]TrashedSessionRecord, 0, len(byID))
	for _, rec := range byID {
		out = append(out, *rec)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if ai, bi := i64ptr(a.DeletedAt), i64ptr(b.DeletedAt); ai != bi {
			return ai > bi
		}
		if a.Cwd != b.Cwd {
			return a.Cwd < b.Cwd
		}
		return a.Title < b.Title
	})
	return out, nil
}

// RestoreFromTrash 把指定会话从废纸篓恢复回原实例:拷回 rollout、回填 session_index、清理条目。
// 若原位置已存在不同会话的文件,为避免覆盖而报错。
func RestoreFromTrash(sessionIDs []string, trashRoot string) (RestoreSummary, error) {
	requested := dedupeTrimmed(sessionIDs)
	if len(requested) == 0 {
		return RestoreSummary{}, errors.New("sessionsync: 请至少选择一条会话")
	}
	all, err := loadTrashEntries(trashRoot)
	if err != nil {
		return RestoreSummary{}, err
	}
	var entries []trashEntry
	for _, e := range all {
		if requested[e.manifest.SessionID] {
			entries = append(entries, e)
		}
	}
	if len(entries) == 0 {
		return RestoreSummary{
			RequestedSessionCount: len(requested),
			Message:               "所选会话在废纸篓中不存在，无需恢复",
		}, nil
	}

	restoredIDs := map[string]bool{}
	restoredInstances := map[string]bool{}
	for _, e := range entries {
		if err := restoreTrashEntry(e); err != nil {
			return RestoreSummary{}, err
		}
		restoredIDs[e.manifest.SessionID] = true
		restoredInstances[e.manifest.InstanceID] = true
	}
	return RestoreSummary{
		RequestedSessionCount: len(requested),
		RestoredSessionCount:  len(restoredIDs),
		RestoredInstanceCount: len(restoredInstances),
		Message:               fmt.Sprintf("已恢复 %d 条会话", len(restoredIDs)),
	}, nil
}

func restoreTrashEntry(e trashEntry) error {
	if _, err := os.Stat(e.trashedRolloutPath); err != nil {
		return fmt.Errorf("sessionsync: 废纸篓中的会话文件不存在，无法恢复 (%s): %s", e.manifest.SessionID, e.trashedRolloutPath)
	}
	target := e.manifest.OriginalRolloutPath

	// 目标已存在时,只有同一会话才允许(幂等);不同会话则拒绝覆盖。
	if _, err := os.Stat(target); err == nil {
		existingID := rolloutSessionID(target)
		if existingID != e.manifest.SessionID {
			return fmt.Errorf("sessionsync: 目标位置已存在不同会话文件，为避免覆盖无法恢复 (待恢复: %s, 已存在: %s): %s",
				e.manifest.SessionID, existingID, target)
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("sessionsync: 创建会话恢复目录失败 (%s): %w", filepath.Dir(target), err)
		}
		if err := copyFile(e.trashedRolloutPath, target); err != nil {
			return fmt.Errorf("sessionsync: 恢复会话文件失败 (%s -> %s): %w", e.trashedRolloutPath, target, err)
		}
	}

	if err := upsertSessionIndexEntry(e.manifest.InstanceRoot, e.manifest.SessionID, e.manifest.SessionIndexEntry, e.manifest.Title); err != nil {
		return err
	}
	if err := os.RemoveAll(e.entryDir); err == nil {
		cleanupEmptyAncestors(e.entryDir)
	}
	return nil
}

// upsertSessionIndexEntry 把一条 session_index 条目写回(已存在同 id 则替换,否则追加)。
// entry 可能是 manifest 里被 MarshalIndent 重新缩进过的多行 JSON,先压成单行以符合 JSONL。
func upsertSessionIndexEntry(dataDir, sessionID string, entry json.RawMessage, title string) error {
	entry = compactJSONLine(entry)
	if len(entry) == 0 {
		entry, _ = json.Marshal(map[string]any{"id": sessionID, "thread_name": title})
	}
	path := filepath.Join(dataDir, sessionIndexFile)
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var kept []string
	replaced := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var probe struct {
			ID string `json:"id"`
		}
		if json.Unmarshal([]byte(trimmed), &probe) == nil && probe.ID == sessionID {
			if replaced {
				continue
			}
			kept = append(kept, string(entry))
			replaced = true
			continue
		}
		kept = append(kept, trimmed)
	}
	if !replaced {
		kept = append(kept, string(entry))
	}
	out := strings.Join(kept, "\n") + "\n"
	return writeFileAtomic(path, []byte(out))
}

func loadTrashEntries(trashRoot string) ([]trashEntry, error) {
	if _, err := os.Stat(trashRoot); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var entries []trashEntry
	// 布局:trashRoot/<batch>/<instance--session>/{manifest.json, files/...}。
	batches, err := os.ReadDir(trashRoot)
	if err != nil {
		return nil, err
	}
	for _, batch := range batches {
		if !batch.IsDir() {
			continue
		}
		batchPath := filepath.Join(trashRoot, batch.Name())
		items, err := os.ReadDir(batchPath)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if !item.IsDir() {
				continue
			}
			entryDir := filepath.Join(batchPath, item.Name())
			manifestPath := filepath.Join(entryDir, "manifest.json")
			mb, err := os.ReadFile(manifestPath)
			if err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return nil, err
			}
			var m trashManifest
			if err := json.Unmarshal(mb, &m); err != nil {
				return nil, fmt.Errorf("sessionsync: 解析废纸篓清单失败 (%s): %w", manifestPath, err)
			}
			entries = append(entries, trashEntry{
				entryDir:           entryDir,
				manifest:           m,
				trashedRolloutPath: filepath.Join(entryDir, "files", filepath.FromSlash(m.RelativeRolloutPath)),
			})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		ai, bi := i64ptr(parseDeletedAt(entries[i].manifest.DeletedAt)), i64ptr(parseDeletedAt(entries[j].manifest.DeletedAt))
		if ai != bi {
			return ai > bi
		}
		if entries[i].manifest.SessionID != entries[j].manifest.SessionID {
			return entries[i].manifest.SessionID < entries[j].manifest.SessionID
		}
		return entries[i].manifest.InstanceID < entries[j].manifest.InstanceID
	})
	return entries, nil
}

// compactJSONLine 把可能多行的 JSON 压成单行;无法解析时原样返回(去首尾空白)。
func compactJSONLine(raw json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(trimmed)); err != nil {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage(buf.Bytes())
}

func rolloutSessionID(path string) string {
	meta, err := readRolloutSessionMeta(path)
	if err != nil || meta == nil {
		return ""
	}
	return sessionMetaID(meta)
}

func parseDeletedAt(raw string) *int64 {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	ts, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil
	}
	sec := ts.Unix()
	return &sec
}

// cleanupEmptyAncestors 自下而上删除已清空的 batch 目录(不越过 trashRoot)。
func cleanupEmptyAncestors(entryDir string) {
	dir := filepath.Dir(entryDir)
	for dir != "" {
		f, err := os.Open(dir)
		if err != nil {
			return
		}
		names, _ := f.Readdirnames(1)
		f.Close()
		if len(names) > 0 {
			return
		}
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

func dedupeTrimmed(ids []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range ids {
		if t := strings.TrimSpace(id); t != "" {
			out[t] = true
		}
	}
	return out
}

func sanitizeFileName(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

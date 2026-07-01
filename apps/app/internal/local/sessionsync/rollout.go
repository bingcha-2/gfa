package sessionsync

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const sessionIndexFile = "session_index.jsonl"

// sessionDirs codex 存放 rollout 的两个根目录(活跃 + 归档)。
var sessionDirs = [...]string{"sessions", "archived_sessions"}

// threadSnapshot 单个实例中扫描到的一条会话(尚未跨实例去重)。
type threadSnapshot struct {
	id          string
	title       string
	cwd         string
	updatedAt   *int64
	rolloutPath string
	indexEntry  json.RawMessage // 原始 session_index 行,移入废纸篓时连同保存以便恢复。
	sourceRoot  string
}

// loadThreadSnapshots 扫描一个实例 DataDir 下所有 rollout 文件,合上 session_index 元数据。
func loadThreadSnapshots(dataDir string) ([]threadSnapshot, error) {
	indexMap, err := readSessionIndexMap(dataDir)
	if err != nil {
		return nil, err
	}
	var snaps []threadSnapshot
	for _, dirName := range sessionDirs {
		root := filepath.Join(dataDir, dirName)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		paths, err := listRolloutFiles(root)
		if err != nil {
			return nil, err
		}
		for _, p := range paths {
			meta, err := readRolloutSessionMeta(p)
			if err != nil {
				return nil, err
			}
			if meta == nil {
				continue
			}
			id := sessionMetaID(meta)
			if id == "" {
				continue
			}
			entry := indexMap[id]
			title := sessionIndexTitle(entry)
			if title == "" {
				title = id
			}
			cwd := sessionMetaCwd(meta)
			if cwd == "" {
				cwd = "未知工作目录"
			}
			updatedAt := sessionIndexUpdatedAtSeconds(entry)
			if updatedAt == nil {
				updatedAt = rolloutFileActivitySeconds(p)
			}
			if updatedAt == nil {
				updatedAt = rolloutFileModifiedSeconds(p)
			}
			raw := entry
			if raw == nil {
				fallback, _ := json.Marshal(map[string]any{"id": id, "thread_name": title})
				raw = fallback
			}
			snaps = append(snaps, threadSnapshot{
				id:          id,
				title:       title,
				cwd:         cwd,
				updatedAt:   updatedAt,
				rolloutPath: p,
				indexEntry:  raw,
				sourceRoot:  dataDir,
			})
		}
	}
	return snaps, nil
}

// listRolloutFiles 递归收集 rollout-*.jsonl,结果排序保证确定性。
func listRolloutFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, ".jsonl") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// readRolloutSessionMeta 读 rollout 首条非空行,要求是 session_meta,否则返回 nil。
func readRolloutSessionMeta(path string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			return nil, nil
		}
		if t, _ := v["type"].(string); t == "session_meta" {
			return v, nil
		}
		return nil, nil
	}
	return nil, sc.Err()
}

func sessionMetaID(meta map[string]any) string {
	if payload, ok := meta["payload"].(map[string]any); ok {
		if s := firstStr(payload, "id", "session_id"); s != "" {
			return s
		}
	}
	return firstStr(meta, "id", "session_id")
}

func sessionMetaCwd(meta map[string]any) string {
	if payload, ok := meta["payload"].(map[string]any); ok {
		if s, ok := payload["cwd"].(string); ok {
			return strings.TrimSpace(s)
		}
	}
	if s, ok := meta["cwd"].(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

// readSessionIndexMap 解析 session_index.jsonl 为 id -> 原始行。
func readSessionIndexMap(dataDir string) (map[string]json.RawMessage, error) {
	path := filepath.Join(dataDir, sessionIndexFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]json.RawMessage{}, nil
		}
		return nil, err
	}
	out := map[string]json.RawMessage{}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var probe struct {
			ID string `json:"id"`
		}
		if json.Unmarshal([]byte(trimmed), &probe) != nil || probe.ID == "" {
			continue
		}
		out[probe.ID] = json.RawMessage(trimmed)
	}
	return out, nil
}

func sessionIndexTitle(entry json.RawMessage) string {
	if entry == nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(entry, &m) != nil {
		return ""
	}
	for _, k := range []string{"thread_name", "threadName", "title", "name"} {
		if s, ok := m[k].(string); ok {
			if t := strings.TrimSpace(s); t != "" {
				return t
			}
		}
	}
	return ""
}

func sessionIndexUpdatedAtSeconds(entry json.RawMessage) *int64 {
	if entry == nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(entry, &m) != nil {
		return nil
	}
	for _, k := range []string{"updated_at", "updatedAt", "last_updated_at", "lastUpdatedAt"} {
		if v, ok := m[k]; ok {
			if sec := parseTimestampSeconds(v); sec != nil {
				return sec
			}
		}
	}
	return nil
}

// rolloutFileActivitySeconds 扫 rollout 全文,取最大时间戳(秒)。
func rolloutFileActivitySeconds(path string) *int64 {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var maxSec int64
	found := false
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		if sec := rolloutLineTimestampSeconds(v); sec != nil {
			if !found || *sec > maxSec {
				maxSec, found = *sec, true
			}
		}
	}
	if !found {
		return nil
	}
	return &maxSec
}

func rolloutLineTimestampSeconds(v map[string]any) *int64 {
	pick := func(m map[string]any) *int64 {
		for _, k := range []string{"timestamp", "time", "created_at", "createdAt"} {
			if raw, ok := m[k]; ok {
				if sec := parseTimestampSeconds(raw); sec != nil {
					return sec
				}
			}
		}
		return nil
	}
	if sec := pick(v); sec != nil {
		return sec
	}
	if payload, ok := v["payload"].(map[string]any); ok {
		return pick(payload)
	}
	return nil
}

func rolloutFileModifiedSeconds(path string) *int64 {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	sec := info.ModTime().Unix()
	return &sec
}

// parseTimestampSeconds 把 number(秒/毫秒/微秒)或 RFC3339/数字字符串归一为 unix 秒。
func parseTimestampSeconds(v any) *int64 {
	switch t := v.(type) {
	case float64:
		sec := normalizeTimestampSeconds(int64(t))
		return &sec
	case json.Number:
		if i, err := t.Int64(); err == nil {
			sec := normalizeTimestampSeconds(i)
			return &sec
		}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil
		}
		if ts, err := time.Parse(time.RFC3339, s); err == nil {
			sec := ts.Unix()
			return &sec
		}
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			sec := normalizeTimestampSeconds(i)
			return &sec
		}
	}
	return nil
}

func normalizeTimestampSeconds(ts int64) int64 {
	switch {
	case ts > 10_000_000_000_000:
		return ts / 1_000_000
	case ts > 10_000_000_000:
		return ts / 1_000
	default:
		return ts
	}
}

func firstStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok {
			if t := strings.TrimSpace(s); t != "" {
				return t
			}
		}
	}
	return ""
}

func i64ptr(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

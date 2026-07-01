package sessionsync

import (
	"bytes"
	"encoding/json"
	"os"
	"sort"
	"strings"
)

// ListSessions 跨实例列出会话(按 sessionId 去重,统计每条会话所在的实例/落点)。
// filter 可按标题(大小写不敏感)和/或 rollout 原文内容过滤。
func ListSessions(instances []Instance, filter SearchFilter) ([]SessionRecord, error) {
	titleQuery := strings.ToLower(strings.TrimSpace(filter.TitleQuery))
	contentQuery := strings.TrimSpace(filter.ContentQuery)
	hasFilter := titleQuery != "" || contentQuery != ""

	byID := map[string]*SessionRecord{}
	matched := map[string]bool{}

	for _, inst := range instances {
		snaps, err := loadThreadSnapshots(inst.DataDir)
		if err != nil {
			return nil, err
		}
		for _, snap := range snaps {
			if hasFilter && !matched[snap.id] {
				ok, err := matchesFilter(snap, titleQuery, contentQuery)
				if err != nil {
					return nil, err
				}
				if ok {
					matched[snap.id] = true
				}
			}

			rec := byID[snap.id]
			if rec == nil {
				rec = &SessionRecord{
					SessionID: snap.id,
					Title:     snap.title,
					Cwd:       snap.cwd,
					UpdatedAt: snap.updatedAt,
				}
				byID[snap.id] = rec
			}
			if rec.UpdatedAt == nil {
				rec.UpdatedAt = snap.updatedAt
			}
			if strings.TrimSpace(rec.Title) == "" {
				rec.Title = snap.title
			}
			if strings.TrimSpace(rec.Cwd) == "" {
				rec.Cwd = snap.cwd
			}
			rec.Locations = append(rec.Locations, SessionLocation{
				InstanceID:   inst.ID,
				InstanceName: inst.Name,
				Running:      inst.Running,
			})
			rec.LocationCount = len(rec.Locations)
		}
	}

	out := make([]SessionRecord, 0, len(byID))
	for _, rec := range byID {
		if hasFilter && !matched[rec.SessionID] {
			continue
		}
		out = append(out, *rec)
	}
	sortSessionRecords(out)
	return out, nil
}

func sortSessionRecords(recs []SessionRecord) {
	sort.SliceStable(recs, func(i, j int) bool {
		a, b := recs[i], recs[j]
		if ai, bi := i64ptr(a.UpdatedAt), i64ptr(b.UpdatedAt); ai != bi {
			return ai > bi // 新的在前。
		}
		if a.Cwd != b.Cwd {
			return a.Cwd < b.Cwd
		}
		return a.Title < b.Title
	})
}

func matchesFilter(snap threadSnapshot, titleQuery, contentQuery string) (bool, error) {
	if titleQuery != "" && !strings.Contains(strings.ToLower(snap.title), titleQuery) {
		return false, nil
	}
	if contentQuery != "" {
		ok, err := rolloutContainsQuery(snap.rolloutPath, contentQuery)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}
	return true, nil
}

// rolloutContainsQuery 在 rollout 原始字节里做子串匹配。query 为纯 ASCII 时大小写不敏感,
// 否则按字节精确匹配(对齐 cockpit raw_bytes_contains_normalized_query)。
func rolloutContainsQuery(path, query string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	q := []byte(query)
	if len(q) == 0 {
		return true, nil
	}
	if isASCII(q) {
		return bytes.Contains(bytes.ToLower(data), bytes.ToLower(q)), nil
	}
	return bytes.Contains(data, q), nil
}

func isASCII(b []byte) bool {
	for _, c := range b {
		if c >= 0x80 {
			return false
		}
	}
	return true
}

// TokenStats 跨实例读取指定会话的累计 token 用量。只返回找得到 token_count 的会话。
func TokenStats(instances []Instance, sessionIDs []string) ([]SessionTokenStats, error) {
	pending := map[string]bool{}
	for _, id := range sessionIDs {
		if t := strings.TrimSpace(id); t != "" {
			pending[t] = true
		}
	}
	if len(pending) == 0 {
		return nil, nil
	}

	byID := map[string]SessionTokenStats{}
	for _, inst := range instances {
		if len(pending) == 0 {
			break
		}
		snaps, err := loadThreadSnapshots(inst.DataDir)
		if err != nil {
			return nil, err
		}
		for _, snap := range snaps {
			if !pending[snap.id] {
				continue
			}
			input, output, total, ok := readTokenStatsFromRollout(snap.rolloutPath)
			if !ok {
				continue
			}
			byID[snap.id] = SessionTokenStats{
				SessionID:    snap.id,
				InputTokens:  input,
				OutputTokens: output,
				TotalTokens:  total,
			}
			delete(pending, snap.id)
		}
	}

	out := make([]SessionTokenStats, 0, len(byID))
	for _, s := range byID {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SessionID < out[j].SessionID })
	return out, nil
}

// readTokenStatsFromRollout 从后往前找最后一条 token_count event_msg,取 total_token_usage。
func readTokenStatsFromRollout(path string) (input, output, total uint64, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, 0, false
	}
	lines := bytes.Split(data, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		// 廉价预筛,避免对每行做 JSON 解析。
		if !bytes.Contains(line, []byte(`"token_count"`)) || !bytes.Contains(line, []byte(`"total_token_usage"`)) {
			continue
		}
		var v struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
				Info struct {
					Total struct {
						Input  uint64 `json:"input_tokens"`
						Output uint64 `json:"output_tokens"`
						Total  uint64 `json:"total_tokens"`
					} `json:"total_token_usage"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &v) != nil {
			continue
		}
		if v.Type != "event_msg" || v.Payload.Type != "token_count" {
			continue
		}
		return v.Payload.Info.Total.Input, v.Payload.Info.Total.Output, v.Payload.Info.Total.Total, true
	}
	return 0, 0, 0, false
}

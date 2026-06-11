package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ─── Codex config.toml 最小改动编辑器 ───────────────────────────────────────
//
// 之前用 go-toml 的 Unmarshal→Marshal 全文件 round-trip:虽然实测不会丢数据,
// 但会重排所有键、统一改写引号风格、丢失注释与空行布局,对用户那份手工维护
// 的 460 行配置非常不友好(diff 噪音巨大、易被怀疑"被改坏")。
//
// 这里改成行级最小编辑:只动我们关心的 `model_provider` 顶层键和
// `[model_providers.<id>]` 这一张表,其余字节原样保留。配合 temp+rename 原子写,
// 杜绝半截写入。
//
// 解析(读当前值)仍走 go-toml(见 codex_inject.go 的 loadCodexConfig),这里只
// 负责"写"。

// isTableHeaderLine 判断是否是 [table] / [[array]] 形式的表头行。
func isTableHeaderLine(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "[")
}

// topLevelKeyName 提取一行的顶层 key 名(去掉引号),非 key=value 行返回 ""。
func topLevelKeyName(line string) string {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "[") {
		return ""
	}
	eq := strings.IndexByte(t, '=')
	if eq <= 0 {
		return ""
	}
	key := strings.TrimSpace(t[:eq])
	key = strings.Trim(key, `"'`)
	return key
}

// findTopRegionEnd 返回顶层区(第一个表头之前)的行数边界。
func findTopRegionEnd(lines []string) int {
	for i, l := range lines {
		if isTableHeaderLine(l) {
			return i
		}
	}
	return len(lines)
}

// setTopLevelString 在顶层区设置 key = "value"(字符串值),已存在则替换,否则插入。
// 保留其余行不变。返回新内容。
func setTopLevelString(content, key, value string) string {
	lines := splitKeepEOL(content)
	end := findTopRegionEnd(lines)
	newLine := fmt.Sprintf("%s = %s", key, tomlQuote(value))
	for i := 0; i < end; i++ {
		if topLevelKeyName(lines[i]) == key {
			lines[i] = newLine + lineEOL(lines[i])
			return strings.Join(lines, "")
		}
	}
	// 未找到:插入到顶层区末尾(跳过末尾连续空行,插在它们之前)。
	insertAt := end
	for insertAt > 0 && strings.TrimSpace(stripEOL(lines[insertAt-1])) == "" {
		insertAt--
	}
	inserted := newLine + "\n"
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:insertAt]...)
	out = append(out, inserted)
	out = append(out, lines[insertAt:]...)
	return strings.Join(out, "")
}

// stripLegacyLocalCodexBaseURL 删除旧版接管残留的顶层 chatgpt_base_url(指向本地代理
// 127.0.0.1 的那种)。新版接管改用自定义 provider,不再写 chatgpt_base_url;旧值若留着,
// Codex 仍会把插件/遥测等杂活请求发到本地代理(被静默吞掉),看起来像"没开代理却还在拦"。
// 只清理指向 127.0.0.1 的本地残留,用户自定义的远程值原样保留。
func stripLegacyLocalCodexBaseURL(content string) string {
	lines := splitKeepEOL(content)
	end := findTopRegionEnd(lines)
	for i := 0; i < end; i++ {
		if topLevelKeyName(lines[i]) == "chatgpt_base_url" && strings.Contains(lines[i], "127.0.0.1") {
			return removeTopLevelKey(content, "chatgpt_base_url")
		}
	}
	return content
}

// removeTopLevelKey 删除顶层区指定 key 所在的行。
func removeTopLevelKey(content, key string) string {
	lines := splitKeepEOL(content)
	end := findTopRegionEnd(lines)
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		if i < end && topLevelKeyName(l) == key {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "")
}

// tableHeaderMatches 判断行是否是给定 dotted 表头,如 [model_providers.bingchaai]。
// 兼容各段被单/双引号包裹的情况。
func tableHeaderMatches(line string, segments []string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "[") || strings.HasPrefix(t, "[[") {
		return false
	}
	closing := strings.IndexByte(t, ']')
	if closing < 0 {
		return false
	}
	inner := strings.TrimSpace(t[1:closing])
	parts := splitDottedKey(inner)
	if len(parts) != len(segments) {
		return false
	}
	for i := range parts {
		if strings.Trim(strings.TrimSpace(parts[i]), `"'`) != segments[i] {
			return false
		}
	}
	return true
}

// findTableBlock 返回 [segments...] 表块的 [start,end) 行区间(含表头,到下一个表头或 EOF)。
// 未找到返回 (-1,-1)。
func findTableBlock(lines []string, segments []string) (int, int) {
	start := -1
	for i, l := range lines {
		if tableHeaderMatches(l, segments) {
			start = i
			break
		}
	}
	if start < 0 {
		return -1, -1
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if isTableHeaderLine(lines[i]) {
			end = i
			break
		}
	}
	return start, end
}

// upsertProviderTable 写入/替换 [model_providers.<id>] 表块。fields 按给定顺序写。
func upsertProviderTable(content, providerID string, fields [][2]string) string {
	segments := []string{"model_providers", providerID}
	var b strings.Builder
	fmt.Fprintf(&b, "[model_providers.%s]\n", providerID)
	for _, kv := range fields {
		fmt.Fprintf(&b, "%s = %s\n", kv[0], kv[1])
	}
	block := b.String()

	lines := splitKeepEOL(content)
	start, end := findTableBlock(lines, segments)
	if start >= 0 {
		out := make([]string, 0, len(lines))
		out = append(out, lines[:start]...)
		out = append(out, block)
		out = append(out, lines[end:]...)
		return strings.Join(out, "")
	}
	// 追加到文件末尾,保证与上文有一空行分隔。
	res := content
	if res != "" && !strings.HasSuffix(res, "\n") {
		res += "\n"
	}
	if res != "" && !strings.HasSuffix(res, "\n\n") {
		res += "\n"
	}
	return res + block
}

// removeProviderTable 删除 [model_providers.<id>] 表块及其紧随的一行空行。
func removeProviderTable(content, providerID string) string {
	segments := []string{"model_providers", providerID}
	lines := splitKeepEOL(content)
	start, end := findTableBlock(lines, segments)
	if start < 0 {
		return content
	}
	// 吞掉块后紧跟的一行空行,避免留下空洞。
	if end < len(lines) && strings.TrimSpace(stripEOL(lines[end])) == "" {
		end++
	}
	// 若块前是空行且块后已无内容,也清掉前导空行。
	if start > 0 && strings.TrimSpace(stripEOL(lines[start-1])) == "" && end >= len(lines) {
		start--
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, lines[end:]...)
	return strings.Join(out, "")
}

// setTableKey 在 [tableSegments] 表块内设置 key = rawValue(rawValue 已是 TOML 字面量,
// 如 `"priority"` 或 `false`)。表块或键不存在则创建。保留其余内容。
func setTableKey(content string, tableSegments []string, key, rawValue string) string {
	lines := splitKeepEOL(content)
	start, end := findTableBlock(lines, tableSegments)
	newKV := fmt.Sprintf("%s = %s", key, rawValue)
	if start < 0 {
		// 整张表都没有:在文件末尾追加表与键。
		var hdr strings.Builder
		hdr.WriteByte('[')
		for i, seg := range tableSegments {
			if i > 0 {
				hdr.WriteByte('.')
			}
			hdr.WriteString(seg)
		}
		hdr.WriteByte(']')
		res := content
		if res != "" && !strings.HasSuffix(res, "\n") {
			res += "\n"
		}
		if res != "" && !strings.HasSuffix(res, "\n\n") {
			res += "\n"
		}
		return res + hdr.String() + "\n" + newKV + "\n"
	}
	// 表存在:在 (start,end) 内查找键。
	for i := start + 1; i < end; i++ {
		if topLevelKeyName(lines[i]) == key {
			lines[i] = newKV + lineEOL(lines[i])
			return strings.Join(lines, "")
		}
	}
	// 键不存在:插到表块末尾(跳过尾部空行)。
	insertAt := end
	for insertAt > start+1 && strings.TrimSpace(stripEOL(lines[insertAt-1])) == "" {
		insertAt--
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:insertAt]...)
	out = append(out, newKV+"\n")
	out = append(out, lines[insertAt:]...)
	return strings.Join(out, "")
}

// removeTableKey 删除 [tableSegments] 表块内的指定键。表或键不存在则原样返回。
func removeTableKey(content string, tableSegments []string, key string) string {
	lines := splitKeepEOL(content)
	start, end := findTableBlock(lines, tableSegments)
	if start < 0 {
		return content
	}
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		if i > start && i < end && topLevelKeyName(l) == key {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "")
}

// readTableKeyString 读取 [tableSegments] 表块内 key 的字符串值(去引号)。不存在返回 ""。
func readTableKeyString(content string, tableSegments []string, key string) string {
	lines := splitKeepEOL(content)
	start, end := findTableBlock(lines, tableSegments)
	if start < 0 {
		return ""
	}
	for i := start + 1; i < end; i++ {
		if topLevelKeyName(lines[i]) != key {
			continue
		}
		t := stripEOL(lines[i])
		eq := strings.IndexByte(t, '=')
		if eq < 0 {
			return ""
		}
		return strings.Trim(strings.TrimSpace(t[eq+1:]), `"'`)
	}
	return ""
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

// splitKeepEOL 按行切分但保留每行的换行符(便于无损重组)。
func splitKeepEOL(s string) []string {
	if s == "" {
		return []string{}
	}
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i+1])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func lineEOL(line string) string {
	if strings.HasSuffix(line, "\r\n") {
		return "\r\n"
	}
	if strings.HasSuffix(line, "\n") {
		return "\n"
	}
	return ""
}

func stripEOL(line string) string {
	return strings.TrimRight(line, "\r\n")
}

// splitDottedKey 按 '.' 切分 dotted key,但不切分引号内的点。
func splitDottedKey(s string) []string {
	var parts []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	for _, r := range s {
		switch {
		case r == '\'' && !inDouble:
			inSingle = !inSingle
			cur.WriteRune(r)
		case r == '"' && !inSingle:
			inDouble = !inDouble
			cur.WriteRune(r)
		case r == '.' && !inSingle && !inDouble:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	parts = append(parts, cur.String())
	return parts
}

// tomlQuote 用 TOML basic string 语法包裹一个字符串值。
func tomlQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`, "\r", `\r`)
	return `"` + r.Replace(s) + `"`
}

// writeFileAtomic 原子写:写临时文件再 rename,避免半截写入损坏 config.toml。
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".bcai-codex-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

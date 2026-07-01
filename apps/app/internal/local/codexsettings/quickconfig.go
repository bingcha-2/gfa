package codexsettings

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

const (
	configTOMLName = "config.toml"

	keyModelContextWindow         = "model_context_window"
	keyModelAutoCompactTokenLimit = "model_auto_compact_token_limit"

	contextWindow1MValue    int64 = 1_000_000
	autoCompactDefaultLimit int64 = 900_000
)

// QuickConfig 是 ~/.codex/config.toml 的快捷视图。JSON 标签对齐 cockpit camelCase。
type QuickConfig struct {
	// ContextWindow1M:model_context_window 是否等于 1_000_000。
	ContextWindow1M bool `json:"contextWindow1m"`
	// AutoCompactTokenLimit:检测到的自动压缩阈值,缺省回退 900_000。
	AutoCompactTokenLimit int64 `json:"autoCompactTokenLimit"`
	// DetectedModelContextWindow:原样检测到的 model_context_window(无则 nil)。
	DetectedModelContextWindow *int64 `json:"detectedModelContextWindow,omitempty"`
	// DetectedAutoCompactTokenLimit:原样检测到的阈值(>0 才保留;无则 nil)。
	DetectedAutoCompactTokenLimit *int64 `json:"detectedAutoCompactTokenLimit,omitempty"`
}

// CodexHomeDir 解析 Codex 主目录,语义对齐 cockpit get_codex_home:
//   - 优先 CODEX_HOME(去空白/去包裹引号);
//   - 否则回退 ~/.codex。
func CodexHomeDir() string {
	if raw, ok := os.LookupEnv("CODEX_HOME"); ok {
		trimmed := strings.TrimSpace(raw)
		unquoted := strings.TrimSpace(strings.Trim(trimmed, `"'`))
		if unquoted != "" {
			return unquoted
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codex"
	}
	return filepath.Join(home, ".codex")
}

// LoadCurrentQuickConfig 读取 CodexHomeDir() 下的 config.toml 快捷配置。
func LoadCurrentQuickConfig() (QuickConfig, error) { return ReadQuickConfig(CodexHomeDir()) }

// SaveCurrentQuickConfig 写 CodexHomeDir() 下的 config.toml 快捷配置。
func SaveCurrentQuickConfig(modelContextWindow, autoCompactTokenLimit *int64) (QuickConfig, error) {
	return SaveQuickConfig(CodexHomeDir(), modelContextWindow, autoCompactTokenLimit)
}

// ReadQuickConfig 从 baseDir/config.toml 解析两个顶层整数键。缺省/空文件回退默认。
func ReadQuickConfig(baseDir string) (QuickConfig, error) {
	content, _ := os.ReadFile(filepath.Join(baseDir, configTOMLName))
	if strings.TrimSpace(string(content)) == "" {
		return QuickConfig{
			ContextWindow1M:       false,
			AutoCompactTokenLimit: autoCompactDefaultLimit,
		}, nil
	}

	var doc map[string]any
	if err := toml.Unmarshal(content, &doc); err != nil {
		return QuickConfig{}, fmt.Errorf("解析 config.toml 失败: %w", err)
	}

	detectedCW := topLevelInt(doc, keyModelContextWindow)
	detectedACL := topLevelInt(doc, keyModelAutoCompactTokenLimit)
	if detectedACL != nil && *detectedACL <= 0 {
		detectedACL = nil // 对齐 cockpit .filter(|v| *v > 0)
	}

	out := QuickConfig{
		ContextWindow1M:               detectedCW != nil && *detectedCW == contextWindow1MValue,
		AutoCompactTokenLimit:         autoCompactDefaultLimit,
		DetectedModelContextWindow:    detectedCW,
		DetectedAutoCompactTokenLimit: detectedACL,
	}
	if detectedACL != nil {
		out.AutoCompactTokenLimit = *detectedACL
	}
	return out, nil
}

// SaveQuickConfig 结构保留地改写 baseDir/config.toml 的两个顶层整数键,然后回读返回。
//   - nil 表示删除该键;非 nil 必须 >0(否则报错)。
//   - 既有内容(注释、其它键、表)原样保留;原子落盘。
//   - 空文件 + 两个 nil:不创建文件,直接回读默认。
func SaveQuickConfig(baseDir string, modelContextWindow, autoCompactTokenLimit *int64) (QuickConfig, error) {
	if modelContextWindow != nil && *modelContextWindow <= 0 {
		return QuickConfig{}, fmt.Errorf("上下文窗口必须大于 0")
	}
	if autoCompactTokenLimit != nil && *autoCompactTokenLimit <= 0 {
		return QuickConfig{}, fmt.Errorf("自动压缩阈值必须大于 0")
	}

	configPath := filepath.Join(baseDir, configTOMLName)
	existing, _ := os.ReadFile(configPath)
	if strings.TrimSpace(string(existing)) == "" &&
		modelContextWindow == nil && autoCompactTokenLimit == nil {
		return ReadQuickConfig(baseDir)
	}

	updated := upsertTopLevelInt(string(existing), keyModelContextWindow, modelContextWindow)
	updated = upsertTopLevelInt(updated, keyModelAutoCompactTokenLimit, autoCompactTokenLimit)

	if err := writeFileAtomic(configPath, []byte(updated), 0o600); err != nil {
		return QuickConfig{}, fmt.Errorf("写入 config.toml 失败: %w", err)
	}
	return ReadQuickConfig(baseDir)
}

// topLevelInt 取顶层整数键(忽略表内同名键)。go-toml 把表解成嵌套 map,
// 顶层标量直接在根 map 上,故只看根层即可。
func topLevelInt(doc map[string]any, key string) *int64 {
	v, ok := doc[key]
	if !ok {
		return nil
	}
	switch n := v.(type) {
	case int64:
		return &n
	case int:
		x := int64(n)
		return &x
	default:
		return nil
	}
}

// upsertTopLevelInt 在 TOML 文本里结构保留地设置/删除一个顶层标量整数键。
//   - val != nil:若键已存在于顶层(首个表头之前)则原地替换;否则在顶层段尾追加。
//   - val == nil:删除顶层该键行(若存在)。
//
// 仅操作顶层(第一个 `[` 表头之前)的键,避免误伤表内同名键。
func upsertTopLevelInt(content, key string, val *int64) string {
	lines := splitLinesKeepEmpty(content)
	topEnd := topLevelEndIndex(lines) // [topStart, topEnd) 为顶层区域

	matchIdx := -1
	for i := 0; i < topEnd; i++ {
		if lineAssignsKey(lines[i], key) {
			matchIdx = i
			break
		}
	}

	if val == nil {
		if matchIdx >= 0 {
			lines = append(lines[:matchIdx], lines[matchIdx+1:]...)
		}
		return strings.Join(lines, "\n")
	}

	newLine := fmt.Sprintf("%s = %d", key, *val)
	if matchIdx >= 0 {
		lines[matchIdx] = newLine
		return strings.Join(lines, "\n")
	}

	// 追加到顶层区域末尾(第一个表头之前)。
	insertAt := topEnd
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:insertAt]...)
	out = append(out, newLine)
	out = append(out, lines[insertAt:]...)
	return strings.Join(out, "\n")
}

// splitLinesKeepEmpty 拆行;丢弃尾随换行造成的空末元素,便于 join 后形态稳定。
func splitLinesKeepEmpty(content string) []string {
	if content == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	// 末尾换行会产生一个空串元素,去掉它(join 时不需要)。
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// topLevelEndIndex 返回第一个表头(`[`)行的下标;无表头则为总行数。
func topLevelEndIndex(lines []string) int {
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			return i
		}
	}
	return len(lines)
}

// lineAssignsKey 判断该行是否为 `key = ...`(忽略前导空白,排除注释)。
func lineAssignsKey(line, key string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return false
	}
	rest, ok := strings.CutPrefix(trimmed, key)
	if !ok {
		return false
	}
	rest = strings.TrimSpace(rest)
	return strings.HasPrefix(rest, "=")
}

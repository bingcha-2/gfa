package codexsettings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// service tier 落地相关常量(对齐 cockpit codex_speed.rs)。
const (
	desktopSection           = "desktop"
	keyDefaultServiceTier    = "default-service-tier"
	globalStateFile          = ".codex-global-state.json"
	atomStateKey             = "electron-persisted-atom-state"
	hasUserChangedTierKey    = "has-user-changed-service-tier"
	serviceTierPriorityValue = "priority"
)

// SaveCurrentServiceTier 把官方 App 速度档落到 CodexHomeDir() 的 config.toml + 全局原子态。
func SaveCurrentServiceTier(fast bool) error { return SaveServiceTier(CodexHomeDir(), fast) }

// SaveServiceTier 落地「快速档」到真 Codex。对齐 cockpit codex_speed.write_official_app_speed:
//   - fast:config.toml [desktop].default-service-tier="priority";
//   - standard:删除该键。
//
// 同时同步 .codex-global-state.json 的 electron-persisted-atom-state —— 这一步是必须的、不是
// 装饰:Codex GUI 启动会用自己持久化的原子态回写 config.toml,不同步就会把我们的改动改回去。
func SaveServiceTier(baseDir string, fast bool) error {
	if err := applyServiceTierToConfigTOML(baseDir, fast); err != nil {
		return err
	}
	return syncServiceTierGlobalState(baseDir, fast)
}

func applyServiceTierToConfigTOML(baseDir string, fast bool) error {
	configPath := filepath.Join(baseDir, configTOMLName)
	existing, _ := os.ReadFile(configPath)

	var val *string
	if fast {
		v := serviceTierPriorityValue
		val = &v
	}
	updated := upsertTableStringKey(string(existing), desktopSection, keyDefaultServiceTier, val)
	// 空内容 + standard(删除)→ 无键可写,不创建文件。
	if strings.TrimSpace(updated) == "" {
		return nil
	}
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return fmt.Errorf("创建 Codex 配置目录失败: %w", err)
	}
	if err := writeFileAtomic(configPath, []byte(updated), 0o600); err != nil {
		return fmt.Errorf("写入 config.toml 失败: %w", err)
	}
	return nil
}

func syncServiceTierGlobalState(baseDir string, fast bool) error {
	path := filepath.Join(baseDir, globalStateFile)
	state := map[string]any{}
	if data, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(data)) != "" {
		_ = json.Unmarshal(data, &state) // 损坏即视为空态(对齐 cockpit 隔离回空)
	}

	atoms, _ := state[atomStateKey].(map[string]any)
	if atoms == nil {
		atoms = map[string]any{}
	}
	if fast {
		atoms[keyDefaultServiceTier] = serviceTierPriorityValue
	} else {
		atoms[keyDefaultServiceTier] = nil // cockpit:Standard 写 null(而非删键)
	}
	atoms[hasUserChangedTierKey] = true
	state[atomStateKey] = atoms

	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("序列化 Codex 全局状态失败: %w", err)
	}
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return fmt.Errorf("创建 Codex 配置目录失败: %w", err)
	}
	if err := writeFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("写入 Codex 全局状态失败: %w", err)
	}
	return nil
}

// upsertTableStringKey 在 TOML 文本里结构保留地设置/删除某表(section)下的一个字符串键。
//   - val != nil:在 [section] 段内设 key="val";段不存在则在文末新建 [section]。
//   - val == nil:删除 [section] 段内的 key 行(若存在);段不存在则不动。
//
// 仅在目标段(从 [section] 头到下一个表头之间)内操作,保留其它内容/注释/键序。
func upsertTableStringKey(content, section, key string, val *string) string {
	lines := splitLinesKeepEmpty(content)
	header := "[" + section + "]"

	secStart := -1
	for i, l := range lines {
		if strings.TrimSpace(l) == header {
			secStart = i
			break
		}
	}

	if secStart < 0 {
		if val == nil {
			return strings.Join(lines, "\n")
		}
		out := append([]string{}, lines...)
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "") // 与既有内容空一行分隔
		}
		out = append(out, header, fmt.Sprintf("%s = %q", key, *val))
		return strings.Join(out, "\n")
	}

	// 目标段范围 [secStart+1, secEnd)。
	secEnd := len(lines)
	for i := secStart + 1; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "[") {
			secEnd = i
			break
		}
	}
	matchIdx := -1
	for i := secStart + 1; i < secEnd; i++ {
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

	newLine := fmt.Sprintf("%s = %q", key, *val)
	if matchIdx >= 0 {
		lines[matchIdx] = newLine
		return strings.Join(lines, "\n")
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:secEnd]...)
	out = append(out, newLine)
	out = append(out, lines[secEnd:]...)
	return strings.Join(out, "\n")
}

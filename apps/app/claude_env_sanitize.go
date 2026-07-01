package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ClaudeConfigConflict 描述一处检测到的第三方中转配置（只读检测的产物）。
// Detect→Sanitize 之间用 ID 引用，避免"检测到 A 却清了 B"。
type ClaudeConfigConflict struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`     // settings-env | cc-switch | os-env | shell-rc | managed-settings
	Scope    string `json:"scope"`    // user | machine | process
	Location string `json:"location"` // 文件路径 / 变量名 / 目录
	Detail   string `json:"detail"`   // 命中的具体内容，例如 ANTHROPIC_BASE_URL=https://…
	Severity string `json:"severity"` // blocking | warning
}

// claude_env_sanitize.go —— 接管前"竞争性第三方中转配置"的检测（P1，只读）。
//
// 背景与决策见 docs/takeover-env-sanitize-plan.md。核心红线：只清"别家"，绝不碰
// GFA 自己注入的接管配置。isGFAOwnedRelayValue 是该红线的判定基石。

// isGFAOwnedRelayValue 判断一个中转值（ANTHROPIC_BASE_URL 地址或 ANTHROPIC_AUTH_TOKEN）
// 是否属于 GFA 自己：指向本地代理（loopback）或等于我们的哨兵 token 即为"自己"。
// 凡本函数返回 true 的值一律不得当作第三方中转清理。空值不是中转，返回 false。
func isGFAOwnedRelayValue(val string, proxyPort int) bool {
	if val == "" {
		return false
	}
	if val == claudeSentinelAuthToken {
		return true
	}
	if strings.HasPrefix(val, claudeProxyBaseURL(proxyPort)) {
		return true
	}
	// 防御性兜底：任何回环地址都视为"自己/安全"，绝不误判为第三方中转。
	return strings.Contains(val, "127.0.0.1") || strings.Contains(val, "localhost")
}

// scanSettingsEnvConflicts 从 settings.json 的 env 块里挑出指向第三方中转的
// ANTHROPIC_BASE_URL。GFA 自己的（loopback/哨兵）和缺省的都不算冲突。
func scanSettingsEnvConflicts(env map[string]interface{}, proxyPort int) []ClaudeConfigConflict {
	raw, _ := env[claudeBaseURLKey].(string)
	if raw == "" || isGFAOwnedRelayValue(raw, proxyPort) {
		return nil
	}
	return []ClaudeConfigConflict{{
		ID:       "settings-env:" + claudeBaseURLKey,
		Kind:     "settings-env",
		Scope:    "user",
		Location: claudeSettingsPath(),
		Detail:   fmt.Sprintf("%s=%s", claudeBaseURLKey, raw),
		Severity: "blocking",
	}}
}

// detectCcSwitch 检测 homeDir 下是否存在 cc-switch 的数据目录（其 SQLite 库是 provider
// 清单/密钥/地址的真相源）。存在即视为高风险第三方中转，前端弹窗会重点点名它。
func detectCcSwitch(homeDir string) []ClaudeConfigConflict {
	dir := filepath.Join(homeDir, ".cc-switch")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil
	}
	return []ClaudeConfigConflict{{
		ID:       "cc-switch",
		Kind:     "cc-switch",
		Scope:    "user",
		Location: dir,
		Detail:   "cc-switch（第三方账号切换工具）",
		Severity: "blocking",
	}}
}

// scanShellRCConflicts 从单个 shell 启动脚本（.zshrc/.bashrc…）里挑出 export 的第三方
// 中转地址。这类 export 会经进程环境盖过 settings.json，是"接管不生效"的隐性来源。
// GFA 自己的 loopback/哨兵值不算冲突；文件不存在则静默返回。
func scanShellRCConflicts(rcPath string, proxyPort int) []ClaudeConfigConflict {
	data, err := os.ReadFile(rcPath)
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		val, ok := exportedThirdPartyBaseURL(line, proxyPort)
		if !ok {
			continue
		}
		// 清理是【整文件级】的（sanitizeShellRCFile 一次删掉文件里所有第三方 export），
		// 故一个文件只报【一条】冲突。每行一条会造成同 ID 重复，进而在编排器复检时把
		// 已清项误判为「未清」。首个命中即代表该文件。
		return []ClaudeConfigConflict{{
			ID:       "shell-rc:" + rcPath,
			Kind:     "shell-rc",
			Scope:    "user",
			Location: rcPath,
			Detail:   fmt.Sprintf("%s=%s", claudeBaseURLKey, val),
			Severity: "warning",
		}}
	}
	return nil
}

// exportedThirdPartyBaseURL 判断一行 shell 脚本是否 export 了第三方 ANTHROPIC_BASE_URL。
// 注释行、非该键、GFA 自己的（loopback/哨兵）值都返回 (,"false")。scan 与 sanitize 共用，
// 确保"检测到的行"与"清理掉的行"判定完全一致。
func exportedThirdPartyBaseURL(line string, proxyPort int) (string, bool) {
	s := strings.TrimSpace(line)
	if strings.HasPrefix(s, "#") {
		return "", false
	}
	s = strings.TrimSpace(strings.TrimPrefix(s, "export "))
	prefix := claudeBaseURLKey + "="
	if !strings.HasPrefix(s, prefix) {
		return "", false
	}
	val := strings.Trim(strings.TrimSpace(strings.TrimPrefix(s, prefix)), `"'`)
	if val == "" || isGFAOwnedRelayValue(val, proxyPort) {
		return "", false
	}
	return val, true
}

// detectManagedSettings 检测企业策略文件 managed-settings.json 是否存在。它是 Claude Code
// 最高优先级的设置层（常由 MDM/组策略下发），会盖过 GFA 写进 settings.json 的接管注入。
// 仅检测存在性；path 为空或指向目录/缺失则不算冲突。
func detectManagedSettings(path string) []ClaudeConfigConflict {
	if path == "" {
		return nil
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return nil
	}
	return []ClaudeConfigConflict{{
		ID:       "managed-settings",
		Kind:     "managed-settings",
		Scope:    "machine",
		Location: path,
		Detail:   "managed-settings.json（企业策略/最高优先级，可能盖过接管；删除需提权，且可能被 MDM 重新下发）",
		Severity: "blocking",
	}}
}

// parseRegQueryValue 从 Windows `reg query ... /v NAME` 的输出里抽出值名 name 的字符串值。
// 输出形如 `    NAME    REG_SZ    <value>`（值可能含空格，取类型 token 之后的全部）。
func parseRegQueryValue(out, name string) (string, bool) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != name {
			continue
		}
		// fields[1] 是类型（REG_SZ / REG_EXPAND_SZ …），其后即为值。
		if !strings.HasPrefix(fields[1], "REG_") {
			continue
		}
		return strings.Join(fields[2:], " "), true
	}
	return "", false
}

// managedSettingsPath 返回本平台 Claude Code 托管策略文件的固定路径。
func managedSettingsPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ClaudeCode/managed-settings.json"
	case "windows":
		return filepath.Join(os.Getenv("PROGRAMDATA"), "ClaudeCode", "managed-settings.json")
	default:
		return "/etc/claude-code/managed-settings.json"
	}
}

// detectCompetingClaudeConfig 是 P1 只读检测的编排入口：合并各来源检测到的第三方中转。
// proxyPort 用于识别 GFA 自己的注入（未接管时传 0 也安全，loopback 兜底仍生效）。
func detectCompetingClaudeConfig(proxyPort int) []ClaudeConfigConflict {
	var conflicts []ClaudeConfigConflict

	if settings, ok := loadClaudeSettings(); ok {
		if env, ok := settings["env"].(map[string]interface{}); ok {
			conflicts = append(conflicts, scanSettingsEnvConflicts(env, proxyPort)...)
		}
	}

	if home, err := os.UserHomeDir(); err == nil {
		conflicts = append(conflicts, detectCcSwitch(home)...)
		for _, rc := range shellRCFiles {
			conflicts = append(conflicts, scanShellRCConflicts(filepath.Join(home, rc), proxyPort)...)
		}
	}

	conflicts = append(conflicts, scanOSEnvConflicts(proxyPort)...)
	conflicts = append(conflicts, detectManagedSettings(managedSettingsPath())...)

	return conflicts
}

// shellRCFiles 是可能 export 第三方中转变量的常见 shell 启动脚本（相对 home）。
var shellRCFiles = []string{".zshrc", ".bashrc", ".bash_profile", ".profile", ".zprofile", ".zshenv"}

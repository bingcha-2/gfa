package main

import (
	"fmt"
	"runtime"
	"strings"
)

// Claude Desktop 把 HKLM/HKCU 的 SOFTWARE\Policies\Claude 当作托管策略读取,优先级高于
// 用户级 configLibrary。其它工具(如 opclaude)留下的网关策略会让我们写入的 profile 被忽略,
// 且 Desktop 不会报错,所以注入前先只读检测。
var desktopPolicyHives = []string{
	`HKLM\SOFTWARE\Policies\Claude`,
	`HKCU\SOFTWARE\Policies\Claude`,
}

// parseRegQueryValues 解析 `reg query <key>` 输出里的 "    名称    REG_XX    数据" 行。
func parseRegQueryValues(out string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "    ", 3)
		if len(f) == 3 && strings.HasPrefix(strings.TrimSpace(f[1]), "REG_") {
			values[strings.TrimSpace(f[0])] = strings.TrimSpace(f[2])
		}
	}
	return values
}

// desktopPolicyConflictIn 返回该策略键与本项目网关冲突的说明,无冲突返回空串。
func desktopPolicyConflictIn(hive string, values map[string]string, baseURL string) string {
	base := strings.TrimRight(values["inferenceGatewayBaseUrl"], "/")
	helper := values["inferenceCredentialHelper"]
	_, hasKey := values["inferenceGatewayApiKey"]
	provider := values["inferenceProvider"]
	if base == "" && helper == "" && !hasKey && provider == "" {
		return ""
	}
	if base == strings.TrimRight(baseURL, "/") && helper == "" && !hasKey {
		return ""
	}
	detail := []string{}
	if provider != "" {
		detail = append(detail, "inferenceProvider="+provider)
	}
	if base != "" {
		detail = append(detail, "inferenceGatewayBaseUrl="+base)
	}
	if helper != "" {
		detail = append(detail, "inferenceCredentialHelper="+helper)
	}
	if hasKey {
		detail = append(detail, "inferenceGatewayApiKey=(已设置)")
	}
	return fmt.Sprintf("%s: %s", hive, strings.Join(detail, ", "))
}

// desktopPolicyConflict 只读检查注册表策略,仅 Windows 有意义。
func desktopPolicyConflict(baseURL string) string {
	if runtime.GOOS != "windows" {
		return ""
	}
	conflicts := []string{}
	for _, hive := range desktopPolicyHives {
		out, err := hideCmd("reg", "query", hive).Output()
		if err != nil {
			continue
		}
		if msg := desktopPolicyConflictIn(hive, parseRegQueryValues(string(out)), baseURL); msg != "" {
			conflicts = append(conflicts, msg)
		}
	}
	return strings.Join(conflicts, "\n")
}

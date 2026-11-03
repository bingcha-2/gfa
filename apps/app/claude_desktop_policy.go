package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// desktopPolicyConflictPrefix 是前端识别「需要用户确认清理策略」的错误前缀。
const desktopPolicyConflictPrefix = "POLICY_CONFLICT:"

// desktopPolicyOwnedValues 是网关接管相关的策略值名。清理时只删这些,
// 不动同一键下 IT/其它工具设置的无关策略(如遥测、自动更新)。
var desktopPolicyOwnedValues = []string{
	"inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey",
	"inferenceGatewayAuthScheme", "inferenceCredentialKind", "inferenceCredentialHelper",
	"inferenceCredentialHelperTtlSec", "inferenceModels",
}

// policyValuesToClear 返回 values 中属于网关接管的值名(保持 desktopPolicyOwnedValues 顺序)。
func policyValuesToClear(values map[string]string) []string {
	var names []string
	for _, n := range desktopPolicyOwnedValues {
		if _, ok := values[n]; ok {
			names = append(names, n)
		}
	}
	return names
}

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

func queryPolicyValues(hive string) map[string]string {
	out, err := hideCmd("reg", "query", hive).Output()
	if err != nil {
		return nil
	}
	return parseRegQueryValues(string(out))
}

// ClearDesktopPolicyConflict 在用户确认后清理冲突的网关策略:先 reg export 备份,
// 再只删网关相关的值。HKCU 直接删;HKLM 需要管理员,直接删失败时通过 UAC 提权重试。
// 返回备份文件所在目录。
func (a *App) ClearDesktopPolicyConflict() (string, error) {
	if runtime.GOOS != "windows" {
		return "", nil
	}
	desktopTakeoverMu.Lock()
	defer desktopTakeoverMu.Unlock()
	base := gatewayClaudeBaseURL()
	backupDir := filepath.Join(getAppDataDir(), "policy-backup")
	stamp := time.Now().Format("20060102-150405")
	var elevated []string
	for _, hive := range desktopPolicyHives {
		values := queryPolicyValues(hive)
		if desktopPolicyConflictIn(hive, values, base) == "" {
			continue
		}
		if err := os.MkdirAll(backupDir, 0700); err != nil {
			return "", err
		}
		name := strings.NewReplacer(`\`, "-", ":", "").Replace(hive)
		file := filepath.Join(backupDir, fmt.Sprintf("%s-%s.reg", name, stamp))
		if out, err := hideCmd("reg", "export", hive, file, "/y").CombinedOutput(); err != nil {
			return "", fmt.Errorf("备份注册表策略失败,已取消清理: %v %s", err, strings.TrimSpace(string(out)))
		}
		for _, n := range policyValuesToClear(values) {
			if err := hideCmd("reg", "delete", hive, "/v", n, "/f").Run(); err != nil {
				elevated = append(elevated, fmt.Sprintf(`reg delete %s /v %s /f`, hive, n))
			}
		}
	}
	if len(elevated) > 0 {
		// 值名与键路径均为固定常量(无空格),可直接拼接进 cmd。
		script := "Start-Process cmd -ArgumentList '/c " + strings.Join(elevated, " & ") + "' -Verb RunAs -Wait -WindowStyle Hidden"
		if err := hideCmd("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Run(); err != nil {
			return "", fmt.Errorf("需要管理员权限清理 HKLM 策略,提权未完成: %v", err)
		}
	}
	if left := desktopPolicyConflict(base); left != "" {
		return "", fmt.Errorf("策略清理未完成,仍存在:\n%s", left)
	}
	return backupDir, nil
}

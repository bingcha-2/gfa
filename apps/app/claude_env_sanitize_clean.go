package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// claude_env_sanitize_clean.go —— P2 清理层：按检测到的冲突执行"备份→删→复检"。
// 红线不变：只清第三方，绝不碰 GFA 自己的注入（由 isGFAOwnedRelayValue 守住）。
// 破坏性动作前一律先备份到统一目录（SanitizeReport.BackupTo），失败/被占用如实标注。

// SanitizeReport 汇报一次清理的结果。
type SanitizeReport struct {
	Cleaned  []string `json:"cleaned"`  // 已清理的冲突 ID
	Skipped  []string `json:"skipped"`  // 未清理（被占用/无权限/未命中）的冲突 ID
	BackupTo string   `json:"backupTo"` // 备份目录，可回滚
	NeedsUAC bool     `json:"needsUac"` // 需提权（Machine 级变量 / managed-settings）时置位
}

// sanitizeBackupDir 返回本次清理的统一备份目录（~/.bcai/sanitize-backup）。
func sanitizeBackupDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bcai", "sanitize-backup")
}

// backupFileTo 把 srcPath 复制进 backupDir（用扁平化文件名避免同名冲突）。
// 源不存在时静默返回 nil —— 没有可备份的东西不是错误。
func backupFileTo(backupDir, srcPath string) error {
	data, err := os.ReadFile(srcPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return err
	}
	flat := strings.ReplaceAll(strings.TrimPrefix(srcPath, string(os.PathSeparator)), string(os.PathSeparator), "_")
	return writeFileAtomic(filepath.Join(backupDir, flat), data, 0o600)
}

// sanitizeSettingsEnvBaseURL 从 settings.json 的 env 块删掉第三方 ANTHROPIC_BASE_URL，
// 保留其余 env 键与顶层设置。GFA 自己的（loopback/哨兵）不动。返回是否发生清理。
func sanitizeSettingsEnvBaseURL(proxyPort int, backupDir string) (bool, error) {
	// 持接管注入用的同一把锁：settings.json 的读改写必须与 InjectClaudeSettings /
	// RestoreClaudeSettings 互斥，否则并发时会互相覆盖（丢数据或撤销对方的写入）。
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	settings, ok := loadClaudeSettings()
	if !ok {
		return false, nil
	}
	env, ok := settings["env"].(map[string]interface{})
	if !ok {
		return false, nil
	}
	raw, _ := env[claudeBaseURLKey].(string)
	if raw == "" || isGFAOwnedRelayValue(raw, proxyPort) {
		return false, nil
	}
	if err := backupFileTo(backupDir, claudeSettingsPath()); err != nil {
		return false, err
	}
	delete(env, claudeBaseURLKey)
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return false, err
	}
	if err := writeFileAtomic(claudeSettingsPath(), data, 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// sanitizeShellRCFile 从单个 shell rc 删掉第三方 export 行，保留其余行。原文件先备份；
// 写回统一用 LF（别给 bash/zsh 塞 CRLF）。无第三方行或文件不存在则返回 (false,nil)。
func sanitizeShellRCFile(rcPath string, proxyPort int, backupDir string) (bool, error) {
	data, err := os.ReadFile(rcPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	changed := false
	for _, line := range lines {
		if _, isThirdParty := exportedThirdPartyBaseURL(line, proxyPort); isThirdParty {
			changed = true
			continue
		}
		kept = append(kept, line)
	}
	if !changed {
		return false, nil
	}
	if err := backupFileTo(backupDir, rcPath); err != nil {
		return false, err
	}
	// 保留原文件权限：用户可能 chmod 600 以隐藏敏感配置，写回时别把它改成全局可读 0o644。
	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(rcPath); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := writeFileAtomic(rcPath, []byte(strings.Join(kept, "\n")), mode); err != nil {
		return false, err
	}
	return true, nil
}

// moveCcSwitchDir 把 ~/.cc-switch 整个搬进备份目录（rename 即"备份+删除"，保住 SQLite 数据）。
// 目录不存在则 (false,nil)。注意：调用方应先结束 cc-switch 进程，否则托盘可能重建目录。
func moveCcSwitchDir(homeDir, backupDir string) (bool, error) {
	src := filepath.Join(homeDir, ".cc-switch")
	if info, err := os.Stat(src); err != nil || !info.IsDir() {
		return false, nil
	}
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return false, err
	}
	dst := filepath.Join(backupDir, ".cc-switch")
	_ = os.RemoveAll(dst) // 同名残留先清，保证 rename 成功
	if err := os.Rename(src, dst); err != nil {
		return false, err
	}
	return true, nil
}

// sanitizeCompetingClaudeConfig 是 P2 清理层的编排入口：重新检测 → 按 ids 逐项清理
// （备份在前）→ 复检。ids 为空表示清理全部检出项。清理后仍被检出的项从 Cleaned 挪到
// Skipped（如 managed-settings 无权限删/被 MDM 重新下发）。App.SanitizeCompetingClaudeConfig 封装它。
func sanitizeCompetingClaudeConfig(ids []string, proxyPort int) (SanitizeReport, error) {
	backupDir := sanitizeBackupDir()
	report := SanitizeReport{BackupTo: backupDir}

	var want map[string]bool
	if len(ids) > 0 {
		want = make(map[string]bool, len(ids))
		for _, id := range ids {
			want[id] = true
		}
	}

	home, _ := os.UserHomeDir()
	for _, c := range detectCompetingClaudeConfig(proxyPort) {
		if want != nil && !want[c.ID] {
			continue
		}
		cleaned, needsUAC, err := sanitizeOneConflict(c, proxyPort, backupDir, home)
		if needsUAC {
			report.NeedsUAC = true
		}
		if err != nil || !cleaned {
			report.Skipped = append(report.Skipped, c.ID)
			continue
		}
		report.Cleaned = append(report.Cleaned, c.ID)
	}

	// 删后复检：清理过的若仍被检出（删失败/被重新下发），从 Cleaned 挪到 Skipped，绝不假装成功。
	if len(report.Cleaned) > 0 {
		stillThere := map[string]bool{}
		for _, c := range detectCompetingClaudeConfig(proxyPort) {
			stillThere[c.ID] = true
		}
		kept := report.Cleaned[:0:0]
		for _, id := range report.Cleaned {
			if stillThere[id] {
				report.Skipped = append(report.Skipped, id)
			} else {
				kept = append(kept, id)
			}
		}
		report.Cleaned = kept
	}

	return report, nil
}

// sanitizeOneConflict 按冲突类型分派清理动作。文件类走跨平台清理器；进程/提权/注册表走平台实现。
func sanitizeOneConflict(c ClaudeConfigConflict, proxyPort int, backupDir, home string) (cleaned, needsUAC bool, err error) {
	switch c.Kind {
	case "settings-env":
		cleaned, err = sanitizeSettingsEnvBaseURL(proxyPort, backupDir)
	case "shell-rc":
		cleaned, err = sanitizeShellRCFile(c.Location, proxyPort, backupDir)
	case "cc-switch":
		killCcSwitchProcess() // 先杀托盘，否则清了目录又被写回（决策 D4）
		cleaned, err = moveCcSwitchDir(home, backupDir)
	case "managed-settings":
		needsUAC = true
		_ = backupFileTo(backupDir, c.Location)
		err = deleteManagedSettingsElevated(c.Location)
		cleaned = err == nil && !fileExists(c.Location)
	case "os-env":
		needsUAC = c.Scope == "machine"
		err = deleteOSEnvVar(c.Scope)
		cleaned = err == nil
	}
	return
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ─────────────── Wails 绑定（供前端 P3 调用）───────────────

// DetectCompetingClaudeConfig 只读检测机器上指向第三方中转的配置（cc-switch、别家
// ANTHROPIC_BASE_URL、企业策略文件等）。GFA 自己的接管注入不会被列入。
func (a *App) DetectCompetingClaudeConfig() ([]ClaudeConfigConflict, error) {
	return detectCompetingClaudeConfig(effectiveProxyPort()), nil
}

// SanitizeCompetingClaudeConfig 备份并清理指定冲突（ids 为空表示清理全部检出）。
// 破坏性动作，前端须先经"封号免责 + 我已知晓"确认再调用。
func (a *App) SanitizeCompetingClaudeConfig(ids []string) (SanitizeReport, error) {
	return sanitizeCompetingClaudeConfig(ids, effectiveProxyPort())
}

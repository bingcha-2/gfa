package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// ─── Claude Code 接管(整份隔离 ~/.claude/settings.json)──────────────────────────
//
// Claude Code CLI 和 VSCode 的 Claude Code 扩展共用同一份配置 ~/.claude/settings.json,
// 通过其中的 env 块向 claude 进程注入环境变量。
//
// 【整份隔离策略(P0)】接管时把用户整份 settings.json 备份走,只写入一份「最小 GFA 注入」:
//
//	{ "env": {
//	    "ANTHROPIC_BASE_URL": "http://127.0.0.1:<proxyPort>",
//	    "ANTHROPIC_AUTH_TOKEN": "<sentinel>",     // 真 token 由本地代理转发时替换
//	    "ANTHROPIC_API_KEY": "",                  // 置空覆盖 shell/系统 export 的真实 key
//	    "CLAUDE_CODE_USE_FOUNDRY": "",            // 置空覆盖 shell export 的 Foundry 开关
//	    "ANTHROPIC_FOUNDRY_RESOURCE": "",
//	    "ANTHROPIC_FOUNDRY_BASE_URL": ""
//	} }
//
// 接管期间用户其余配置(模型覆盖键、顶层 model、hooks、插件市场、statusLine、权限、第三方
// 中转 BASE_URL 等)一律不生效 —— 从源头杜绝「别名/号池不认的模型 → 公开 API 404」「第三方
// 中转/插件把租来的 token 带出去」等隐患。取消接管时整份还原用户原文件,不丢任何用户配置。
//
// 为什么置空(而非删除)API_KEY / Foundry:Claude Code 启动时 Object.assign(process.env,
// settings.env)。若 shell 里 export 了 ANTHROPIC_API_KEY / CLAUDE_CODE_USE_FOUNDRY,删除
// settings 里的同名键挡不住 shell;唯有写「空串」才能经 Object.assign 覆盖掉 shell 值。
// 空串被 claude 视作未设置 → 强制走哨兵 AUTH_TOKEN→代理链路,不进 API-key / Foundry 模式。
//
// 【与桌面 MITM 接管共存】桌面端(claudeDesktopTarget)走 MITM,不注入 BASE_URL,但其 spawn
// 的 Code 子进程仍读同一份 settings.json,故用 CleanClaudeModelConfig 单清模型配置。两条路径
// 共用一份备份 + CLIActive/DesktopActive 双层标志协调:谁先动谁捕获「真原文件」,最后一个取消
// 接管者才整份还原真原文件并删备份;中途取消的一方按对方是否仍在生效决定写回何种态。

const (
	claudeBaseURLKey   = "ANTHROPIC_BASE_URL"
	claudeAuthTokenKey = "ANTHROPIC_AUTH_TOKEN"
	claudeApiKeyKey    = "ANTHROPIC_API_KEY"
	claudeTimezoneKey  = "TZ"
	// 哨兵 token:Claude Code 要求 ANTHROPIC_AUTH_TOKEN 非空才会走 ANTHROPIC_BASE_URL;
	// 真正打上游用的 OAuth token 由本地代理在转发时替换,这里只占位。
	claudeSentinelAuthToken = "bcai-claude-proxy"
)

// claudeModelOverrideKeys 是 Claude Code 用来「把某个模型槽位定死成具体模型名」的 env 键。
// 整份隔离时它们随用户配置一并被隔离;桌面 MITM 的单清模型路径(stripModelFromSettings)
// 也据此删除 —— 否则 -thinking 等别名 / 号池不认的 id 会经 MITM 原样打到公开 API → 404。
var claudeModelOverrideKeys = []string{
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
}

// claudeFoundryKeys 是 Claude Code 切到 Azure AI Foundry 上游的 env 键。CLAUDE_CODE_USE_FOUNDRY
// 优先级高于 ANTHROPIC_BASE_URL:为真则 CLI 改用 Foundry endpoint,绕过本地代理 → 接管失效。
// 最小注入里把这三个写「空串」以覆盖 shell export;捕获真原文件时把我们写的空串剥掉,避免误当用户原值。
var claudeFoundryKeys = []string{
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	"ANTHROPIC_FOUNDRY_BASE_URL",
}

var claudeInjectMu sync.Mutex

// claudeConfigDir 返回 Claude Code 配置目录(CLAUDE_CONFIG_DIR 可覆盖,默认 ~/.claude)。
func claudeConfigDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func claudeSettingsPath() string { return filepath.Join(claudeConfigDir(), "settings.json") }
func claudeBackupPath() string   { return filepath.Join(claudeConfigDir(), ".bcai-claude-backup.json") }

// claudeGlobalConfigPath 返回全局配置 .claude.json 的路径。注意:它在「家目录(或
// CLAUDE_CONFIG_DIR)」根下,与 settings.json(在 ~/.claude 子目录)不同 —— 对照反编译
// 源码 src/utils/env.ts: join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json")。
func claudeGlobalConfigPath() string {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		base, _ = os.UserHomeDir()
	}
	return filepath.Join(base, ".claude.json")
}

func claudeProxyBaseURL(proxyPort int) string {
	return fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
}

// claudeBackup 记录接管前的「真原文件」+ 两条接管路径的生效标志(供整份还原/共存协调)。
type claudeBackup struct {
	// OriginalCaptured=true 表示真原文件已捕获(幂等保护:谁先动谁捕获,其后不再覆盖)。
	// 老格式备份(无此字段)反序列化后为 false,一律按「无可靠原文件」的 legacy 路径处理。
	OriginalCaptured bool `json:"originalCaptured"`
	// HadFile=接管前 settings.json 是否存在;Original=其原始文件内容(已剥掉我们自己的注入痕迹)。
	HadFile  bool   `json:"hadFile"`
	Original string `json:"original,omitempty"`
	// CLIActive=Claude Code 完整接管(InjectClaudeSettings)是否生效;
	// DesktopActive=桌面 MITM 单清模型(CleanClaudeModelConfig)是否生效。
	CLIActive     bool `json:"cliActive"`
	DesktopActive bool `json:"desktopActive"`
}

// loadClaudeSettings 读取 settings.json 为通用 map。返回 (settings, exists)。
func loadClaudeSettings() (map[string]interface{}, bool) {
	data, err := os.ReadFile(claudeSettingsPath())
	if err != nil {
		return map[string]interface{}{}, false
	}
	m := map[string]interface{}{}
	if json.Unmarshal(data, &m) != nil {
		return map[string]interface{}{}, true
	}
	return m, true
}

// readClaudeSettingsRaw 读取 settings.json 原始字节。返回 (raw, exists)。
func readClaudeSettingsRaw() ([]byte, bool) {
	data, err := os.ReadFile(claudeSettingsPath())
	if err != nil {
		return nil, false
	}
	return data, true
}

func writeClaudeSettings(settings map[string]interface{}) error {
	dir := claudeConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化 settings.json 失败: %w", err)
	}
	return writeFileAtomic(claudeSettingsPath(), data, 0o644)
}

// minimalClaudeSettings 返回「最小 GFA 注入」settings:只含把上游指向本地代理 + 中和
// API_KEY/Foundry 的 env,别无其它。用户原有的一切键都不在其中(已备份,取消接管时整份还原)。
func minimalClaudeSettings(proxyPort int) map[string]interface{} {
	env := map[string]interface{}{
		claudeBaseURLKey:   claudeProxyBaseURL(proxyPort),
		claudeAuthTokenKey: claudeSentinelAuthToken,
		claudeApiKeyKey:    "",
	}
	for _, k := range claudeFoundryKeys {
		env[k] = ""
	}
	if tz := hostProtectionProcessTimezone(); tz != "" {
		env[claudeTimezoneKey] = tz
	}
	return map[string]interface{}{"env": env}
}

// stripModelFromSettings 就地删掉模型配置:env 里的模型覆盖键 + 顶层 model 字段。保留其余。
func stripModelFromSettings(m map[string]interface{}) {
	if env, ok := m["env"].(map[string]interface{}); ok {
		for _, k := range claudeModelOverrideKeys {
			delete(env, k)
		}
		if len(env) == 0 {
			delete(m, "env")
		} else {
			m["env"] = env
		}
	}
	delete(m, "model")
}

// captureClaudeOriginal 幂等捕获「真原文件」。仅首个改动接管的一方会真正捕获;其后(含另一条
// 接管路径、幂等重入)因 OriginalCaptured=true 直接跳过,绝不把已被我们改过的文件误当原值。
// 捕获时剥掉我们自己的注入痕迹(loopback BASE_URL / 哨兵 AUTH_TOKEN / 我们置的空 API_KEY /
// 空 Foundry),避免「升级-接管中途」把代理 URL 当用户原值还原回去。
func captureClaudeOriginal(bk *claudeBackup) {
	if bk.OriginalCaptured {
		return
	}
	bk.OriginalCaptured = true
	raw, existed := readClaudeSettingsRaw()
	bk.HadFile = existed
	if !existed {
		bk.Original = ""
		return
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil {
		bk.Original = string(raw) // 用户原本就是坏 JSON → 原样存,还原时原样写回,不擅改
		return
	}
	if env, ok := m["env"].(map[string]interface{}); ok {
		if v, _ := env[claudeBaseURLKey].(string); isGFAOwnedRelayValue(v, 0) {
			delete(env, claudeBaseURLKey)
		}
		if v, _ := env[claudeAuthTokenKey].(string); v == claudeSentinelAuthToken {
			delete(env, claudeAuthTokenKey)
		}
		deleteIfEmptyString(env, claudeApiKeyKey)
		for _, k := range claudeFoundryKeys {
			deleteIfEmptyString(env, k)
		}
		if tz, _ := env[claudeTimezoneKey].(string); tz != "" && tz == hostProtectionProcessTimezone() {
			delete(env, claudeTimezoneKey)
		}
		if len(env) == 0 {
			delete(m, "env")
		} else {
			m["env"] = env
		}
	}
	if b, e := json.MarshalIndent(m, "", "  "); e == nil {
		bk.Original = string(b)
	} else {
		bk.Original = string(raw)
	}
}

// deleteIfEmptyString 仅当 key 存在且值为空串时删除(我们注入的占位空串);真实值不动。
func deleteIfEmptyString(env map[string]interface{}, key string) {
	if v, ok := env[key].(string); ok && v == "" {
		delete(env, key)
	}
}

// restoreClaudeOriginalFile 把备份里的真原文件写回 settings.json。stripModel=true 时写回
// 「真原文件减去模型配置」(供另一条接管路径仍生效时用,避免 Code 子进程读到别名 → 404)。
// 原本没有 settings.json 则删除该文件。
func restoreClaudeOriginalFile(bk *claudeBackup, stripModel bool) error {
	if !bk.HadFile {
		_ = os.Remove(claudeSettingsPath())
		return nil
	}
	if !stripModel {
		return writeFileAtomic(claudeSettingsPath(), []byte(bk.Original), 0o644)
	}
	var m map[string]interface{}
	if json.Unmarshal([]byte(bk.Original), &m) != nil {
		return writeFileAtomic(claudeSettingsPath(), []byte(bk.Original), 0o644) // 坏 JSON 无法 strip,原样写回
	}
	stripModelFromSettings(m)
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(claudeSettingsPath(), data, 0o644)
}

// legacyRemoveClaudeInjection 兜底:无备份 / 老格式备份时,尽力从当前文件删掉我们注入的键
// (不删文件、不动用户其余键)。用于升级前已接管、备份是老格式的场景。
func legacyRemoveClaudeInjection() {
	settings, had := loadClaudeSettings()
	if !had {
		return
	}
	if env, ok := settings["env"].(map[string]interface{}); ok {
		delete(env, claudeBaseURLKey)
		delete(env, claudeAuthTokenKey)
		delete(env, claudeApiKeyKey)
		for _, k := range claudeModelOverrideKeys {
			delete(env, k)
		}
		for _, k := range claudeFoundryKeys {
			delete(env, k)
		}
		delete(env, claudeTimezoneKey)
		if len(env) == 0 {
			delete(settings, "env")
		} else {
			settings["env"] = env
		}
	}
	delete(settings, "model")
	_ = writeClaudeSettings(settings)
}

// InjectClaudeSettings 整份隔离 ~/.claude/settings.json:备份真原文件,只写最小 GFA 注入。
func InjectClaudeSettings(proxyPort int) error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk == nil {
		bk = &claudeBackup{}
	}
	captureClaudeOriginal(bk) // 首个改动者捕获真原文件(幂等)
	bk.CLIActive = true
	writeClaudeBackup(bk)

	if err := writeClaudeSettings(minimalClaudeSettings(proxyPort)); err != nil {
		return err
	}
	// 预置 onboarding,接管后不再弹首次引导(Welcome/Security notes/Press Enter)。
	ensureClaudeOnboardingComplete()
	Log("[claude-inject] 已整份隔离 ~/.claude/settings.json(仅保留 GFA 注入): %s=%s (path: %s)",
		claudeBaseURLKey, claudeProxyBaseURL(proxyPort), claudeSettingsPath())
	return nil
}

// RestoreClaudeSettings 取消 Claude Code 完整接管。若桌面 MITM 仍生效则还原「真原文件减模型」
// 并保留备份;否则整份还原真原文件并删备份。
func RestoreClaudeSettings() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk == nil || !bk.OriginalCaptured {
		// 无备份 / 老格式:尽力移除我们注入的键,不删文件。
		legacyRemoveClaudeInjection()
		_ = os.Remove(claudeBackupPath())
		return nil
	}
	bk.CLIActive = false
	if bk.DesktopActive {
		// 桌面 MITM 仍生效:还原真原文件但减模型(供其 Code 子进程用合法默认模型)。备份留着。
		if err := restoreClaudeOriginalFile(bk, true); err != nil {
			return err
		}
		writeClaudeBackup(bk)
		Log("[claude-inject] CLI 取消接管,桌面 MITM 仍生效 → 还原原配置(减模型),保留备份")
		return nil
	}
	if err := restoreClaudeOriginalFile(bk, false); err != nil {
		return err
	}
	_ = os.Remove(claudeBackupPath())
	Log("[claude-inject] 已整份还原 ~/.claude/settings.json")
	return nil
}

// ensureClaudeOnboardingComplete 预置 ~/.claude.json 的 theme + hasCompletedOnboarding,
// 让 claude 接管后不再弹首次 onboarding。判定依据反编译源码 interactiveHelpers.tsx:
// `!config.theme || !config.hasCompletedOnboarding` 就弹;且 `claude /logout` 会把
// hasCompletedOnboarding 重置为 false(logout.tsx),故每次接管都兜一下。
//
// 仅在缺失/为假时写;这两个标志幂等且良性,取消接管「不」还原 —— 还原成 false 反而会
// 让用户下次正常用 claude 又弹引导。文件存在但 JSON 解析失败时直接跳过,绝不回写,
// 避免毁掉用户那份(含登录态/项目历史的)全局配置。
func ensureClaudeOnboardingComplete() {
	cfg, ok := loadClaudeGlobalConfig()
	if !ok {
		return
	}
	changed := false
	if t, _ := cfg["theme"].(string); t == "" {
		cfg["theme"] = "dark"
		changed = true
	}
	if done, _ := cfg["hasCompletedOnboarding"].(bool); !done {
		cfg["hasCompletedOnboarding"] = true
		changed = true
	}
	if !changed {
		return
	}
	if data, e := json.MarshalIndent(cfg, "", "  "); e == nil {
		_ = writeFileAtomic(claudeGlobalConfigPath(), data, 0o600)
		Log("[claude-inject] 已预置 onboarding(theme + hasCompletedOnboarding): %s", claudeGlobalConfigPath())
	}
}

// loadClaudeGlobalConfig 读 ~/.claude.json 为 map。返回 (cfg, ok):文件不存在 → 空 map+true
// (可安全新建);存在但解析失败 → nil+false(调用方据此跳过回写,保护用户配置)。
func loadClaudeGlobalConfig() (map[string]interface{}, bool) {
	data, err := os.ReadFile(claudeGlobalConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{}, true
		}
		return nil, false
	}
	m := map[string]interface{}{}
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	return m, true
}

func readClaudeBackup() *claudeBackup {
	data, err := os.ReadFile(claudeBackupPath())
	if err != nil {
		return nil
	}
	var bk claudeBackup
	if json.Unmarshal(data, &bk) != nil {
		return nil
	}
	return &bk
}

func writeClaudeBackup(bk *claudeBackup) {
	if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
		_ = os.MkdirAll(claudeConfigDir(), 0o755)
		_ = writeFileAtomic(claudeBackupPath(), b, 0o644)
	}
}

// CleanClaudeModelConfig 供桌面端 MITM 接管调用:桌面端硬覆盖 ANTHROPIC_BASE_URL,env 注入
// 对它无效,但其 spawn 的 Code 子进程仍读 settings.json 的模型配置 —— 留着会把别名 / 号池不认
// 的 id 经 MITM 原样打到公开 api.anthropic.com → 404。故单清模型配置,不注入 BASE_URL。
// 若 Claude Code 完整接管已生效(当前已是 GFA 最小文件、本就无模型),则无需再动。
func CleanClaudeModelConfig() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk == nil {
		bk = &claudeBackup{}
	}
	captureClaudeOriginal(bk)
	bk.DesktopActive = true
	writeClaudeBackup(bk)

	if bk.CLIActive {
		return nil // 完整接管已把文件隔离成最小态(无模型),无需再清
	}
	if err := restoreClaudeOriginalFile(bk, true); err != nil {
		return err
	}
	Log("[claude-inject] 已清理用户自定义模型配置(顶层 model + 模型 env 键): %s", claudeSettingsPath())
	return nil
}

// RestoreClaudeModelConfig 取消桌面 MITM 接管。若 Claude Code 完整接管仍生效,文件应保持隔离
// 态、模型保持清除 —— 只落标志、保留备份;否则整份还原真原文件并删备份。
func RestoreClaudeModelConfig() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk == nil || !bk.OriginalCaptured {
		_ = os.Remove(claudeBackupPath())
		return nil
	}
	bk.DesktopActive = false
	if bk.CLIActive {
		writeClaudeBackup(bk)
		Log("[claude-inject] 桌面取消接管,CLI 完整接管仍生效 → 保持隔离,跳过模型还原")
		return nil
	}
	if err := restoreClaudeOriginalFile(bk, false); err != nil {
		return err
	}
	_ = os.Remove(claudeBackupPath())
	Log("[claude-inject] 已整份还原用户配置(含模型)")
	return nil
}

// detectClaudeCodePath 检测 Claude Code 是否可接管:配置目录已存在,或 `claude`
// CLI 在 PATH 上(VSCode 扩展也读同一份 ~/.claude/settings.json)。返回检测到的
// 配置目录路径,未检测到返回 ""。
func detectClaudeCodePath() string {
	if st, err := os.Stat(claudeConfigDir()); err == nil && st.IsDir() {
		return claudeConfigDir()
	}
	if p, err := exec.LookPath("claude"); err == nil && p != "" {
		return claudeConfigDir()
	}
	return ""
}

// IsClaudeInjected 判断 settings.json 当前是否已把上游指向本地代理端口。
func IsClaudeInjected(proxyPort int) bool {
	settings, had := loadClaudeSettings()
	if !had {
		return false
	}
	env, ok := settings["env"].(map[string]interface{})
	if !ok {
		return false
	}
	base, _ := env[claudeBaseURLKey].(string)
	return base == claudeProxyBaseURL(proxyPort)
}

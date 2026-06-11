package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// ─── Claude Code 接管(注入 ~/.claude/settings.json 的 env 块)──────────────────
//
// Claude Code CLI 和 VSCode 的 Claude Code 扩展共用同一份配置 ~/.claude/settings.json,
// 通过其中的 env 块向 claude 进程注入环境变量。把上游指向本地代理只需写两个变量:
//
//	{ "env": {
//	    "ANTHROPIC_BASE_URL": "http://127.0.0.1:<proxyPort>",
//	    "ANTHROPIC_AUTH_TOKEN": "<sentinel>"   // 真 token 由本地代理在转发时注入
//	} }
//
// 与 codex 的自定义 provider 不同,这里无需 CA、无需 MITM —— CLI 一次注入,下次启动
// 即生效;VSCode 扩展 Reload Window 后重读 settings 即生效。
//
// 写入策略:读出整份 settings(map)→ 只动 env 里的这两个键(保留用户其余键/其余 env
// 变量)→ json.MarshalIndent 原子写。首次注入前把这两个键的原值备份到
// .bcai-claude-backup.json,Restore() 据此精确还原(原本没有就删除,原本有值就写回)。

const (
	claudeBaseURLKey   = "ANTHROPIC_BASE_URL"
	claudeAuthTokenKey = "ANTHROPIC_AUTH_TOKEN"
	claudeApiKeyKey    = "ANTHROPIC_API_KEY"
	// 哨兵 token:Claude Code 要求 ANTHROPIC_AUTH_TOKEN 非空才会走 ANTHROPIC_BASE_URL;
	// 真正打上游用的 OAuth token 由本地代理在转发时替换,这里只占位。
	claudeSentinelAuthToken = "bcai-claude-proxy"
)

// claudeModelOverrideKeys 是 Claude Code 用来「把某个模型槽位定死成具体模型名」的 env 键。
// 接管时必须把用户这些定义【删掉】:它们常被设成 -thinking 等别名(如
// claude-opus-4-6-thinking),而我们转发到的公开 API api.anthropic.com 不认这类别名 → 404。
// 删掉后 Claude Code 用自带的合法默认模型 id。取消接管时按备份原样写回(不丢用户配置)。
var claudeModelOverrideKeys = []string{
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
}

// 为什么要中和 ANTHROPIC_API_KEY:Claude Code 启动时 Object.assign(process.env,
// settings.env),只要进程里存在非空 ANTHROPIC_API_KEY(来自用户 shell 或 settings.json
// 自带),claude 就进入「API Usage Billing」(API-key 模式),忽略我们注入的哨兵
// ANTHROPIC_AUTH_TOKEN,把用户个人 key 直接发给本地代理 → 接管失效 + "Both
// ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set" 告警。把它在 settings.env 里置「空字符串」
// 而非删除:置空才能经 Object.assign 覆盖 shell 里 export 的同名变量(删除挡不住 shell)。
// 空串被 claude 视作未设置 → 强制改走 AUTH_TOKEN→代理链路。还原时按备份写回/删除。

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

// claudeEnvBackup 记录注入前目标键的原始状态(供精确还原)。
type claudeEnvBackup struct {
	Injected bool `json:"injected"`
	// BaseBackedUp=true 表示 BASE_URL/AUTH_TOKEN 原值已捕获(幂等保护)。老备份没有此字段
	// 但 Injected=true,迁移时按已捕获处理 —— 避免把已注入的代理 URL 误当成用户原值。
	BaseBackedUp  bool   `json:"baseBackedUp"`
	HadBaseURL    bool   `json:"hadBaseUrl"`
	PrevBaseURL   string `json:"prevBaseUrl"`
	HadAuthToken  bool   `json:"hadAuthToken"`
	PrevAuthToken string `json:"prevAuthToken"`
	HadApiKey     bool   `json:"hadApiKey"`
	PrevApiKey    string `json:"prevApiKey"`
	// 接管时删除的模型覆盖键原值;ModelsBackedUp=true 表示已捕获过(避免重复注入覆盖)。
	ModelsBackedUp bool                     `json:"modelsBackedUp"`
	Models         []claudeModelBackupEntry `json:"models,omitempty"`
	// 接管时删除的 settings 顶层 model 字段原值(与 ModelsBackedUp 一同捕获)。
	// 用户用 /model 切换的模型持久化在此字段,光删 env 模型键挡不住它。
	HadModel  bool   `json:"hadModel"`
	PrevModel string `json:"prevModel"`
}

// claudeModelBackupEntry 记录单个模型覆盖键注入前的状态。
type claudeModelBackupEntry struct {
	Key  string `json:"key"`
	Had  bool   `json:"had"`
	Prev string `json:"prev"`
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

// envBlock 返回 settings 里的 env 子 map(没有则新建一个空 map 并不挂载)。
func envBlock(settings map[string]interface{}) map[string]interface{} {
	if env, ok := settings["env"].(map[string]interface{}); ok {
		return env
	}
	return map[string]interface{}{}
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

// InjectClaudeSettings 把 ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL 指向本地代理,
// 并写入哨兵 ANTHROPIC_AUTH_TOKEN。保留用户其余设置/其余 env 变量;最小改动 + 原子写。
func InjectClaudeSettings(proxyPort int) error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	settings, _ := loadClaudeSettings()
	env := envBlock(settings)

	// 备份原值,供 Restore 精确还原。拆成两块各自幂等捕获(captureClaudeBaseBackup /
	// captureClaudeModelBackup),这样桌面端「只清模型」和 Claude Code「完整注入」可共用同一份
	// 备份而不互相把对方记下的用户原值覆盖掉。ANTHROPIC_API_KEY 是真实密钥,必须在被置空前
	// 可靠捕获:只要当前存在真实 key(非空串)且尚未记过就补记,兼容老备份升级场景。
	bk := readClaudeBackup()
	if bk == nil {
		bk = &claudeEnvBackup{}
	}
	changed := false
	if captureClaudeBaseBackup(bk, env) {
		changed = true
	}
	if !bk.HadApiKey {
		// 仅捕获真实 key(非空字符串);我们自己写入的占位空串不会被误记。
		if v, ok := env[claudeApiKeyKey].(string); ok && v != "" {
			bk.HadApiKey = true
			bk.PrevApiKey = v
			changed = true
		}
	}
	if captureClaudeModelBackup(bk, settings, env) {
		changed = true
	}
	if changed {
		writeClaudeBackup(bk)
	}

	env[claudeBaseURLKey] = claudeProxyBaseURL(proxyPort)
	env[claudeAuthTokenKey] = claudeSentinelAuthToken
	// 中和 ANTHROPIC_API_KEY(置空覆盖 shell/settings 里的真实 key),强制走哨兵 AUTH_TOKEN→代理。
	env[claudeApiKeyKey] = ""
	// 删除用户的模型覆盖键 + 顶层 model 字段(原值已备份):避免 -thinking 等别名 / 号池不认的
	// id 打到公开 API 被 404,让 Claude Code 用自带合法默认模型。取消接管时 RestoreClaudeSettings 写回。
	for _, key := range claudeModelOverrideKeys {
		delete(env, key)
	}
	delete(settings, "model")
	settings["env"] = env

	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	// 预置 onboarding,接管后不再弹首次引导(Welcome/Security notes/Press Enter)。
	ensureClaudeOnboardingComplete()
	Log("[claude-inject] 已注入 ~/.claude/settings.json: %s=%s (path: %s)",
		claudeBaseURLKey, claudeProxyBaseURL(proxyPort), claudeSettingsPath())
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

// RestoreClaudeSettings 还原注入前的状态:原本没有这两个键就删掉,原本有值就写回。
// env 块清空后整体删除。保留用户其余设置。最小改动 + 原子写。
func RestoreClaudeSettings() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	settings, had := loadClaudeSettings()
	if !had {
		_ = os.Remove(claudeBackupPath())
		return nil
	}
	env := envBlock(settings)

	bk := readClaudeBackup()
	restoreKey := func(key, prev string, hadKey bool) {
		if hadKey {
			env[key] = prev
		} else {
			delete(env, key)
		}
	}
	if bk != nil {
		restoreKey(claudeBaseURLKey, bk.PrevBaseURL, bk.HadBaseURL)
		restoreKey(claudeAuthTokenKey, bk.PrevAuthToken, bk.HadAuthToken)
		restoreKey(claudeApiKeyKey, bk.PrevApiKey, bk.HadApiKey)
		// 把接管时删掉的模型覆盖键写回(原本没有的保持删除)。
		for _, m := range bk.Models {
			restoreKey(m.Key, m.Prev, m.Had)
		}
		// 顶层 model 字段:原本有值写回,原本没有保持删除。
		if bk.HadModel {
			settings["model"] = bk.PrevModel
		} else {
			delete(settings, "model")
		}
	} else {
		// 没有备份(异常情况):尽力移除我们写入的键 + 我们会删的模型键 / model 字段(无原值可还,只能删)。
		delete(env, claudeBaseURLKey)
		delete(env, claudeAuthTokenKey)
		delete(env, claudeApiKeyKey)
		for _, key := range claudeModelOverrideKeys {
			delete(env, key)
		}
		delete(settings, "model")
	}

	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}

	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	_ = os.Remove(claudeBackupPath())
	Log("[claude-inject] 已还原 ~/.claude/settings.json")
	return nil
}

func readClaudeBackup() *claudeEnvBackup {
	data, err := os.ReadFile(claudeBackupPath())
	if err != nil {
		return nil
	}
	var bk claudeEnvBackup
	if json.Unmarshal(data, &bk) != nil {
		return nil
	}
	return &bk
}

func writeClaudeBackup(bk *claudeEnvBackup) {
	if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
		_ = os.MkdirAll(claudeConfigDir(), 0o755)
		_ = writeFileAtomic(claudeBackupPath(), b, 0o644)
	}
}

// captureClaudeBaseBackup 幂等捕获 BASE_URL/AUTH_TOKEN 注入前原值。返回 true 表示本次有捕获
// (需落盘)。已捕获过(含老备份:Injected=true 但无 BaseBackedUp 字段)→ 标记后返回 false,
// 绝不重复捕获 —— 否则会把上一轮已注入的代理 URL 误当成用户原值,还原时还错。
func captureClaudeBaseBackup(bk *claudeEnvBackup, env map[string]interface{}) bool {
	if bk.BaseBackedUp || bk.Injected {
		bk.BaseBackedUp = true
		return false
	}
	bk.BaseBackedUp = true
	bk.Injected = true
	if v, ok := env[claudeBaseURLKey].(string); ok {
		bk.HadBaseURL = true
		bk.PrevBaseURL = v
	} else if _, ok := env[claudeBaseURLKey]; ok {
		bk.HadBaseURL = true
	}
	if v, ok := env[claudeAuthTokenKey].(string); ok {
		bk.HadAuthToken = true
		bk.PrevAuthToken = v
	} else if _, ok := env[claudeAuthTokenKey]; ok {
		bk.HadAuthToken = true
	}
	return true
}

// captureClaudeModelBackup 幂等捕获模型覆盖 env 键 + 顶层 model 字段原值。返回 true 表示本次
// 有捕获(需落盘)。已捕获过返回 false。兼容「老版本已接管、此刻才升级到会删模型的新版」:
// 那时这些键 / model 字段还原封不动,正好能被捕获到。
func captureClaudeModelBackup(bk *claudeEnvBackup, settings, env map[string]interface{}) bool {
	if bk.ModelsBackedUp {
		return false
	}
	bk.ModelsBackedUp = true
	for _, key := range claudeModelOverrideKeys {
		entry := claudeModelBackupEntry{Key: key}
		if v, ok := env[key].(string); ok {
			entry.Had = true
			entry.Prev = v
		} else if _, ok := env[key]; ok {
			entry.Had = true // 非字符串(异常)也记为存在,还原时按原值写不回但至少不丢键语义
		}
		bk.Models = append(bk.Models, entry)
	}
	if v, ok := settings["model"].(string); ok {
		bk.HadModel = true
		bk.PrevModel = v
	} else if _, ok := settings["model"]; ok {
		bk.HadModel = true
	}
	return true
}

// CleanClaudeModelConfig 仅清掉用户自定义的模型配置 —— settings.json 顶层 model 字段 +
// ANTHROPIC_* 模型覆盖 env 键,不注入 BASE_URL/AUTH_TOKEN。供桌面端 MITM 接管调用:桌面端
// 硬覆盖 ANTHROPIC_BASE_URL,env 注入对它无效,但其 spawn 的 Code 子进程仍会读 settings.json
// 的 model 字段 / 模型 env 键 —— 留着会把 -thinking 等别名或号池不认的 id 经 MITM 原样打到
// 公开 api.anthropic.com → 404。清掉后 Code 回落到自带合法默认模型,纯 MITM 直转、无需改写。
// 原值备份到 .bcai-claude-backup.json(与完整注入共用,各自幂等),Restore 据此还原。
func CleanClaudeModelConfig() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	settings, had := loadClaudeSettings()
	if !had {
		return nil // 没有 settings.json,无可清理
	}
	env := envBlock(settings)

	bk := readClaudeBackup()
	if bk == nil {
		bk = &claudeEnvBackup{}
	}
	if captureClaudeModelBackup(bk, settings, env) {
		writeClaudeBackup(bk)
	}

	for _, key := range claudeModelOverrideKeys {
		delete(env, key)
	}
	delete(settings, "model")
	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}
	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	Log("[claude-inject] 已清理用户自定义模型配置(顶层 model + 模型 env 键): %s", claudeSettingsPath())
	return nil
}

// RestoreClaudeModelConfig 还原 CleanClaudeModelConfig 清掉的模型配置。若完整接管
// (BaseBackedUp,即 Claude Code env 注入)仍在用,模型配置应保持清除状态 —— 直接跳过、
// 不动备份,避免把别名重新放回去害 CLI 路径 404。否则按备份精确还原并删除备份。
func RestoreClaudeModelConfig() error {
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk != nil && bk.BaseBackedUp {
		Log("[claude-inject] 完整接管仍生效,跳过模型配置还原(保持清除态)")
		return nil
	}

	settings, had := loadClaudeSettings()
	if !had {
		_ = os.Remove(claudeBackupPath())
		return nil
	}
	env := envBlock(settings)

	if bk != nil {
		for _, m := range bk.Models {
			if m.Had {
				env[m.Key] = m.Prev
			} else {
				delete(env, m.Key)
			}
		}
		if bk.HadModel {
			settings["model"] = bk.PrevModel
		} else {
			delete(settings, "model")
		}
	} else {
		// 无备份(异常):尽力删除我们清过的键(无原值可还,只能删)。
		for _, key := range claudeModelOverrideKeys {
			delete(env, key)
		}
		delete(settings, "model")
	}
	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}
	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	_ = os.Remove(claudeBackupPath())
	Log("[claude-inject] 已还原用户自定义模型配置")
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

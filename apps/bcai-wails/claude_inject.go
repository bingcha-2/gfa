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

func claudeProxyBaseURL(proxyPort int) string {
	return fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
}

// claudeEnvBackup 记录注入前两个目标键的原始状态(供精确还原)。
type claudeEnvBackup struct {
	Injected      bool   `json:"injected"`
	HadBaseURL    bool   `json:"hadBaseUrl"`
	PrevBaseURL   string `json:"prevBaseUrl"`
	HadAuthToken  bool   `json:"hadAuthToken"`
	PrevAuthToken string `json:"prevAuthToken"`
	HadApiKey     bool   `json:"hadApiKey"`
	PrevApiKey    string `json:"prevApiKey"`
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

	// 首次注入:把两个目标键的原值备份(再次注入时不覆盖备份,保证还原拿到的是用户原值)。
	if _, statErr := os.Stat(claudeBackupPath()); os.IsNotExist(statErr) {
		bk := claudeEnvBackup{Injected: true}
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
		if v, ok := env[claudeApiKeyKey].(string); ok {
			bk.HadApiKey = true
			bk.PrevApiKey = v
		} else if _, ok := env[claudeApiKeyKey]; ok {
			bk.HadApiKey = true
		}
		if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
			_ = os.MkdirAll(claudeConfigDir(), 0o755)
			_ = writeFileAtomic(claudeBackupPath(), b, 0o644)
		}
	}

	env[claudeBaseURLKey] = claudeProxyBaseURL(proxyPort)
	env[claudeAuthTokenKey] = claudeSentinelAuthToken
	// 中和 ANTHROPIC_API_KEY(置空覆盖 shell/settings 里的真实 key),强制走哨兵 AUTH_TOKEN→代理。
	env[claudeApiKeyKey] = ""
	settings["env"] = env

	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	Log("[claude-inject] 已注入 ~/.claude/settings.json: %s=%s (path: %s)",
		claudeBaseURLKey, claudeProxyBaseURL(proxyPort), claudeSettingsPath())
	return nil
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
	} else {
		// 没有备份(异常情况):尽力移除我们写入的键。
		delete(env, claudeBaseURLKey)
		delete(env, claudeAuthTokenKey)
		delete(env, claudeApiKeyKey)
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

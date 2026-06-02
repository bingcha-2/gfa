package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	toml "github.com/pelletier/go-toml/v2"
)

// ─── Codex 接管(注入 ~/.codex/config.toml,自定义 provider 模式)─────────────
//
// 对照 cockpit 的 codex_local_access:把 Codex 切到一个自定义 model_provider,指向
// 本地代理的 /v1(OpenAI 兼容)端点。
//
// 为什么不改 chatgpt_base_url:新版 Codex 桌面版在 ChatGPT 原生模式下,对话走
// WebSocket(wss),HTTP 代理拦不到生成请求(实测改 chatgpt_base_url 后,插件等杂活
// 来了,但 /responses 一条没有)。切到自定义 provider 并写 supports_websockets=false
// 后,Codex 改走 HTTP POST /v1/responses,代理才拦得到。
//
// 写入策略:行级最小编辑(见 codex_config.go),只动 model_provider 顶层键 +
// [model_providers.bingchaai] 这一张表,保留用户其余配置/注释/键序原样;temp+rename
// 原子写。代价:模型列表来自代理 /v1/models、显示 BingchaAI(provider 模式固有),
// 历史按 provider 分桶的问题由 codex_history.go 的可见性修复兜底。

// 接管写入的 config.toml 形态:
//
//	model_provider = "bingchaai"
//	[model_providers.bingchaai]
//	name = "BingchaAI"
//	base_url = "http://127.0.0.1:<port>/v1"
//	wire_api = "responses"
//	requires_openai_auth = false      # 用号池租号注入上游 token,Codex 无需自带鉴权
//	supports_websockets = false       # 强制走 HTTP,不走 wss(否则代理拦不到)
const (
	codexDefaultProvider = "openai"
	codexProviderID      = "bingchaai"
	codexProviderName    = "BingchaAI"
	codexModelProvider   = "model_provider"
)

func codexHomeDir() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

func codexConfigPath() string { return filepath.Join(codexHomeDir(), "config.toml") }
func codexBackupPath() string { return filepath.Join(codexHomeDir(), ".bcai-codex-backup.json") }

// codexProxyBaseURL 返回写入 provider base_url 的本地代理端点(/v1, OpenAI 兼容)。
func codexProxyBaseURL(proxyPort int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/v1", proxyPort)
}

type codexBackup struct {
	Injected          bool        `json:"injected"`
	HadConfig         bool        `json:"hadConfig"`
	PrevModelProvider interface{} `json:"prevModelProvider"`
}

// loadCodexConfig 读取 config.toml 为通用 map(仅用于读当前状态)。
// 返回 (config, exists, error)。文件不存在时返回空 map + false。
func loadCodexConfig() (map[string]interface{}, bool, error) {
	data, err := os.ReadFile(codexConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{}, false, nil
		}
		return nil, false, err
	}
	m := map[string]interface{}{}
	if err := toml.Unmarshal(data, &m); err != nil {
		return nil, true, fmt.Errorf("解析 ~/.codex/config.toml 失败: %w", err)
	}
	return m, true, nil
}

// readCodexConfigRaw 读取 config.toml 原始字节(保留格式)。不存在返回 "" + false。
func readCodexConfigRaw() (string, bool, error) {
	data, err := os.ReadFile(codexConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(data), true, nil
}

// prevProviderFromBackup 返回备份中记录的原 model_provider(可能为空=原本未设)。
func prevProviderFromBackup() string {
	if prev, ok := readCodexBackupPrev().(string); ok {
		return prev
	}
	return ""
}

// InjectCodexSettings 把 Codex 切到自定义 provider 指向本地代理 /v1(最小改动 + 原子写)。
// 写 model_provider + [model_providers.bingchaai],含 supports_websockets=false 强制走 HTTP。
func InjectCodexSettings(proxyPort int) error {
	content, had, err := readCodexConfigRaw()
	if err != nil {
		return err
	}

	// 首次注入时备份原 model_provider(供还原),避免覆盖用户原有自定义供应商。
	if _, statErr := os.Stat(codexBackupPath()); os.IsNotExist(statErr) {
		var prev interface{}
		if m, _, e := loadCodexConfig(); e == nil {
			prev = m[codexModelProvider]
		}
		bk := codexBackup{Injected: true, HadConfig: had, PrevModelProvider: prev}
		if b, e := json.MarshalIndent(bk, "", "  "); e == nil {
			_ = os.MkdirAll(codexHomeDir(), 0o755)
			_ = writeFileAtomic(codexBackupPath(), b, 0o644)
		}
	}

	// 清掉旧版接管残留的本地 chatgpt_base_url(新版用自定义 provider,不再用它);
	// 否则它和新 provider 并存,Codex 仍会把杂活请求发到本地代理。
	content = stripLegacyLocalCodexBaseURL(content)
	content = setTopLevelString(content, codexModelProvider, codexProviderID)
	content = upsertProviderTable(content, codexProviderID, [][2]string{
		{"name", tomlQuote(codexProviderName)},
		{"base_url", tomlQuote(codexProxyBaseURL(proxyPort))},
		{"wire_api", tomlQuote("responses")},
		{"requires_openai_auth", "false"},
		{"supports_websockets", "false"},
	})
	return writeFileAtomic(codexConfigPath(), []byte(content), 0o644)
}

// RestoreCodexSettings 移除我们的 provider 条目并复位 model_provider(最小改动 + 原子写)。
func RestoreCodexSettings() error {
	content, had, err := readCodexConfigRaw()
	if err != nil {
		return err
	}
	if !had {
		_ = os.Remove(codexBackupPath())
		return nil
	}

	content = removeProviderTable(content, codexProviderID)
	content = stripLegacyLocalCodexBaseURL(content)
	prev := prevProviderFromBackup()
	if prev != "" && prev != codexProviderID {
		// 用户原本有自定义 provider:恢复它。
		content = setTopLevelString(content, codexModelProvider, prev)
	} else {
		// 原本无 model_provider(用官方默认):删掉我们写入的键即可回到默认。
		content = removeTopLevelKey(content, codexModelProvider)
	}
	if err := writeFileAtomic(codexConfigPath(), []byte(content), 0o644); err != nil {
		return err
	}
	_ = os.Remove(codexBackupPath())
	return nil
}

// CleanupLegacyCodexTakeover 启动时清理旧版接管残留的本地 chatgpt_base_url。
// 新版用自定义 provider 接管,旧 chatgpt_base_url=127.0.0.1 是孤儿,留着会让 Codex
// 把插件/遥测等杂活继续发到本地代理(被静默吞掉)。仅在确有残留时才写盘。
func CleanupLegacyCodexTakeover() error {
	content, had, err := readCodexConfigRaw()
	if err != nil || !had {
		return err
	}
	cleaned := stripLegacyLocalCodexBaseURL(content)
	if cleaned == content {
		return nil
	}
	if err := writeFileAtomic(codexConfigPath(), []byte(cleaned), 0o644); err != nil {
		return err
	}
	Log("[codex] 已清理旧版接管残留的本地 chatgpt_base_url(Codex 将直连 chatgpt.com)")
	return nil
}

func readCodexBackupPrev() interface{} {
	data, err := os.ReadFile(codexBackupPath())
	if err != nil {
		return nil
	}
	var bk codexBackup
	if json.Unmarshal(data, &bk) != nil {
		return nil
	}
	return bk.PrevModelProvider
}

// IsCodexInjected 判断 config.toml 当前是否已切到我们的自定义 provider。
func IsCodexInjected() bool {
	m, had, err := loadCodexConfig()
	if err != nil || !had {
		return false
	}
	if mp, _ := m[codexModelProvider].(string); mp != codexProviderID {
		return false
	}
	providers, _ := m["model_providers"].(map[string]interface{})
	if providers == nil {
		return false
	}
	_, ok := providers[codexProviderID]
	return ok
}

// codexProcessPattern 是用于 pgrep/pkill 匹配 Codex 主 app 进程树的模式。
// 注意:"Codex.app/Contents" 不会误匹配 "Codex Computer Use.app/Contents"
// (后者无 "Codex.app" 子串),所以不会误杀 computer-use 辅助服务。
const codexProcessPattern = "Codex.app/Contents"

// IsCodexRunning 检测 Codex 主 app 是否在运行。
func IsCodexRunning() bool {
	switch runtime.GOOS {
	case "darwin", "linux":
		out, err := exec.Command("pgrep", "-f", codexProcessPattern).Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq Codex.exe", "/NH").Output()
		if err != nil {
			return false
		}
		return !strings.Contains(string(out), "No tasks")
	default:
		return false
	}
}

// QuitCodexApp 退出正在运行的 Codex(同步,尽力而为)。退出后 state_5.sqlite 解锁,
// 才能安全地修复历史可见性。
//
// macOS:不用 `osascript tell application ... quit`(需要自动化/Apple Events 权限,
// Wails app 未授权时静默失败,导致 Codex 退不掉、随后 `open -a` 拉不起新实例 ——
// 即"无法唤起")。改用 pgrep+kill(SIGTERM→等待→SIGKILL),与 ide_inject.go 一致。
func QuitCodexApp() {
	switch runtime.GOOS {
	case "darwin", "linux":
		if !IsCodexRunning() {
			return
		}
		killProcessesByPattern(codexProcessPattern, "-TERM")
		if !waitForProcessExit(IsCodexRunning, 5*time.Second) {
			killProcessesByPattern(codexProcessPattern, "-9")
			waitForProcessExit(IsCodexRunning, 2*time.Second)
		}
		if IsCodexRunning() {
			Log("[codex] 警告:Codex 仍在运行,可能影响配置重载")
		}
	case "windows":
		_ = exec.Command("taskkill", "/IM", "Codex.exe", "/T", "/F").Run()
		waitForProcessExit(IsCodexRunning, 3*time.Second)
	}
}

// LaunchCodexApp 启动 Codex(尽力而为)。
func LaunchCodexApp() {
	path := detectCodexAppPath()
	if path == "" {
		Log("[codex] 未检测到 Codex 安装路径,跳过启动")
		return
	}
	switch runtime.GOOS {
	case "darwin":
		// open -a 对 .app bundle 是正确方式;-n 不强制新实例(已退出时正常冷启动)。
		if err := exec.Command("open", "-a", path).Start(); err != nil {
			Log("[codex] 启动 Codex 失败: %v", err)
		}
	case "windows", "linux":
		if err := exec.Command(path).Start(); err != nil {
			Log("[codex] 启动 Codex 失败: %v", err)
		}
	}
}

// RestartCodexAfterTakeover 退出 → 把历史会话 provider 对齐到 targetProvider → 启动。
// 串行后台执行,保证修复 SQLite 时 Codex 已退出(数据库未被占用)。
//
// provider 模式下 Codex 按 model_provider 给历史分桶展示:接管后当前 provider 是
// bingchaai,需把历史 retag 到 bingchaai 才在当前视图可见;还原后回到 openai,需
// retag 回 openai。targetProvider 由调用方按接管/还原传入。
func RestartCodexAfterTakeover(targetProvider string) {
	defer func() {
		if r := recover(); r != nil {
			Log("[codex] 重启编排 panic: %v", r)
		}
	}()
	QuitCodexApp()
	if _, err := AlignCodexHistoryVisibility(codexHomeDir(), targetProvider); err != nil {
		Log("[codex] 对齐历史可见性失败(不致命): %v", err)
	}
	LaunchCodexApp()
}

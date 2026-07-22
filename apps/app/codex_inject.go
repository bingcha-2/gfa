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

// ─── Codex 接管(注入 ~/.codex/config.toml,自定义 provider)────────────
//
// 远程托管不能伪造 ChatGPT OAuth 登录态。新版 Codex Desktop 启动时会用
// access_token 直连 chatgpt.com/backend-api/wham/* 和 /settings/user;伪 JWT 一定被
// 官方验签拒绝,最终反复 account/read + 401 并卡在白屏。
//
// 因此远程接管使用自定义 bingchaai provider，只把 Responses API 指向本地代理 /v1，
// 并固定 requires_openai_auth=false。服务端只下发短期 access token、不下发可轮换的
// refresh token，不能可靠维持 Desktop 的 OAuth 账号态。真实池号 token 只在
// CodexProxy 转发到上游的瞬间注入,不落盘到用户机器。
//
// 内置 provider 会先尝试 WebSocket;代理对本机 /v1/responses Upgrade 返回 426,
// Codex 官方 fallback 会立即切到 HTTP POST,再进入现有租号转发链路。
//
// 写入策略:行级最小编辑(见 codex_config.go),只动 model_provider/openai_base_url
// 和 [model_providers.bingchaai],保留用户其余配置/注释/键序原样。

// 接管写入的 config.toml 形态:
//
//	model_provider = "bingchaai"
//	[model_providers.bingchaai]
//	name = "冰茶 AI"
//	base_url = "http://127.0.0.1:<port>/v1"
//	wire_api = "responses"
//	requires_openai_auth = false
//	http_headers = { "x-openai-actor-authorization" = "bingchaai" }
const (
	codexDefaultProvider = "openai"
	codexProviderID      = "bingchaai"
	codexModelProvider   = "model_provider"
	codexOpenAIBaseURL   = "openai_base_url"
	codexActorHeader     = "x-openai-actor-authorization"
	codexActorValue      = "bingchaai"
)

func codexHomeDir() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

func codexConfigPath() string { return filepath.Join(codexHomeDir(), "config.toml") }

// codexConfiguredModel 读 ~/.codex/config.toml 顶层 model —— 用户在 GUI/CLI 选定的模型。
// 客户端漏发 model 时据此回落(而非硬编码 gpt-5-codex),保证归属/计费记到真实选择。无则空。
func codexConfiguredModel() string {
	m, _, err := loadCodexConfig()
	if err != nil {
		return ""
	}
	s, _ := m["model"].(string)
	return strings.TrimSpace(s)
}
func codexBackupPath() string { return filepath.Join(codexHomeDir(), ".bcai-codex-backup.json") }

// codexProxyBaseURL 返回写入 provider base_url 的本地代理端点(/v1, OpenAI 兼容)。
func codexProxyBaseURL(proxyPort int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/v1", proxyPort)
}

type codexBackup struct {
	Injected          bool        `json:"injected"`
	HadConfig         bool        `json:"hadConfig"`
	PrevModelProvider interface{} `json:"prevModelProvider"`
	PrevOpenAIBaseURL interface{} `json:"prevOpenAIBaseURL"`
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

func prevOpenAIBaseURLFromBackup() string {
	data, err := os.ReadFile(codexBackupPath())
	if err != nil {
		return ""
	}
	var backup codexBackup
	if json.Unmarshal(data, &backup) != nil {
		return ""
	}
	prev, _ := backup.PrevOpenAIBaseURL.(string)
	return prev
}

func ensureCodexBackup(hadConfig bool) error {
	config, _, err := loadCodexConfig()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(codexBackupPath())
	if os.IsNotExist(err) {
		backup := codexBackup{
			Injected:          true,
			HadConfig:         hadConfig,
			PrevModelProvider: config[codexModelProvider],
			PrevOpenAIBaseURL: config[codexOpenAIBaseURL],
		}
		encoded, marshalErr := json.MarshalIndent(backup, "", "  ")
		if marshalErr != nil {
			return marshalErr
		}
		if err := os.MkdirAll(codexHomeDir(), 0o755); err != nil {
			return err
		}
		return writeFileAtomic(codexBackupPath(), encoded, 0o644)
	}
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return fmt.Errorf("解析 Codex 接管备份失败: %w", err)
	}
	if _, exists := fields["prevOpenAIBaseURL"]; exists {
		return nil
	}
	var backup codexBackup
	if err := json.Unmarshal(data, &backup); err != nil {
		return fmt.Errorf("解析 Codex 接管备份失败: %w", err)
	}
	backup.PrevOpenAIBaseURL = config[codexOpenAIBaseURL]
	encoded, err := json.MarshalIndent(backup, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(codexBackupPath(), encoded, 0o644)
}

// InjectCodexSettings 把远程托管 provider 指向本地代理 /v1。
func InjectCodexSettings(proxyPort int) error {
	content, had, err := readCodexConfigRaw()
	if err != nil {
		return err
	}

	// 首次注入备份两个顶层键;旧版备份缺 openai_base_url 时在覆盖前就地补录。
	if err := ensureCodexBackup(had); err != nil {
		return err
	}

	// 清掉其他接管残留,避免顶层 openai_base_url 或本地厂商表并存。
	content = stripLegacyLocalCodexBaseURL(content)
	content = removeProviderTable(content, codexProviderID)
	content = removeProviderTable(content, codexLocalProviderID)
	content = removeTopLevelKey(content, codexOpenAIBaseURL)
	content = setTopLevelString(content, codexModelProvider, codexProviderID)
	content = upsertProviderTable(content, codexProviderID, [][2]string{
		{"name", tomlQuote(codexRemoteProviderName)},
		{"base_url", tomlQuote(codexProxyBaseURL(proxyPort))},
		{"wire_api", tomlQuote("responses")},
		{"requires_openai_auth", "false"},
		// Codex only exposes its built-in image_gen extension to custom no-auth
		// providers that opt in through this non-empty actor header. This mirrors
		// Cockpit's provider projection; the header is a capability marker, not an
		// upstream credential.
		{"http_headers", fmt.Sprintf("{ %s = %s }", tomlQuote(codexActorHeader), tomlQuote(codexActorValue))},
		{"supports_websockets", "false"},
	})
	return writeFileAtomic(codexConfigPath(), []byte(content), 0o644)
}

// RestoreCodexSettings 移除本机 base URL 并复位原 model_provider/openai_base_url。
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
	content = removeProviderTable(content, codexLocalProviderID) // 自定义厂商接管的表
	content = stripLegacyLocalCodexBaseURL(content)
	prevProvider := prevProviderFromBackup()
	if prevProvider != "" && prevProvider != codexProviderID && prevProvider != codexLocalProviderID {
		// 用户原本有自定义 provider:恢复它。
		content = setTopLevelString(content, codexModelProvider, prevProvider)
	} else {
		// 原本无 model_provider(用官方默认):删掉我们写入的键即可回到默认。
		content = removeTopLevelKey(content, codexModelProvider)
	}
	if prevBaseURL := prevOpenAIBaseURLFromBackup(); prevBaseURL != "" {
		content = setTopLevelString(content, codexOpenAIBaseURL, prevBaseURL)
	} else {
		content = removeTopLevelKey(content, codexOpenAIBaseURL)
	}
	if err := writeFileAtomic(codexConfigPath(), []byte(content), 0o644); err != nil {
		return err
	}
	_ = os.Remove(codexBackupPath())
	return nil
}

// CleanupLegacyCodexTakeover 启动时清理旧版接管残留的本地 chatgpt_base_url。
// 新版用 openai_base_url 接管,旧 chatgpt_base_url=127.0.0.1 是孤儿,留着会让 Codex
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

// providerHasCodexActorAuthorization 判断自定义 provider 是否声明了 Codex 内置
// image_gen 所需的 actor capability。Codex 对 header 名大小写不敏感、值只要求非空。
func providerHasCodexActorAuthorization(provider map[string]interface{}) bool {
	headers, _ := provider["http_headers"].(map[string]interface{})
	for name, raw := range headers {
		value, _ := raw.(string)
		if strings.EqualFold(strings.TrimSpace(name), codexActorHeader) && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// IsCodexInjected 判断 config.toml 当前是否已把带 image_gen capability 的无鉴权
// 远程 provider 指向本机代理。旧版缺 actor header 的配置必须返回 false，促使重新注入。
func IsCodexInjected(proxyPort int) bool {
	m, had, err := loadCodexConfig()
	if err != nil || !had {
		return false
	}
	if mp, _ := m[codexModelProvider].(string); mp != codexProviderID {
		return false
	}
	providers, _ := m["model_providers"].(map[string]interface{})
	provider, _ := providers[codexProviderID].(map[string]interface{})
	baseURL, _ := provider["base_url"].(string)
	providerName, _ := provider["name"].(string)
	return baseURL == codexProxyBaseURL(proxyPort) &&
		providerName == codexRemoteProviderName &&
		providerHasCodexActorAuthorization(provider)
}

func currentCodexModelProvider() string {
	m, had, err := loadCodexConfig()
	if err == nil && had {
		if provider, _ := m[codexModelProvider].(string); strings.TrimSpace(provider) != "" {
			return provider
		}
	}
	return codexDefaultProvider
}

// codexProcessTreePattern 是用于 pgrep/kill 匹配 Codex 整个 app 进程树的模式
// (主进程 + 渲染/GPU 辅助 + Resources/codex app-server 等子进程)。品牌名从实际安装
// 反推(codexDesktopBrand),兼容改名后的 ChatGPT.app;反推不到回落 "Codex"。
// 注意:"<Brand>.app/Contents" 不会误匹配 "Codex Computer Use.app/Contents"
// (后者无 "Codex.app" 子串),所以不会误杀 computer-use 辅助服务。
func codexProcessTreePattern() string { return codexDesktopBrand() + ".app/Contents" }

// codexGUIMainPattern 只匹配 GUI 主进程(<Brand>.app/Contents/MacOS/<Brand>),
// 用于判断"GUI 是否真的起来了"。它刻意排除:
//   - Resources/codex(headless CLI / app-server 子进程)—— 接管失败时可能残留,
//     旧逻辑会把它误判成"Codex 在运行",掩盖 GUI 没拉起的事实;
//   - Frameworks/.../Helpers/Codex (Renderer|GPU).app —— 这些路径前缀不是 "<Brand>.app"。
func codexGUIMainPattern() string {
	b := codexDesktopBrand()
	return b + ".app/Contents/MacOS/" + b
}

// codexWindowsImageName 返回 Windows GUI 进程映像名(tasklist/taskkill 用),随品牌改名。
func codexWindowsImageName() string { return codexDesktopBrand() + ".exe" }

// IsCodexRunning 检测 Codex GUI 主程序是否在运行(不含 bundle 内的 CLI 子进程)。
func IsCodexRunning() bool {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("pgrep", "-f", codexGUIMainPattern()).Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "linux":
		out, err := exec.Command("pgrep", "-f", codexProcessTreePattern()).Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+codexWindowsImageName(), "/NH").Output()
		if err != nil {
			return false
		}
		return !strings.Contains(string(out), "No tasks")
	default:
		return false
	}
}

// isCodexProcessTreeRunning 检测 Codex 进程树是否还有任何进程存活(含 CLI/app-server 子进程)。
// QuitCodexApp 用它来等待"彻底退出":只有当 Resources/codex app-server 也退出后,
// state_5.sqlite 的锁才会释放,后续历史对齐才安全。比 IsCodexRunning(只看 GUI)更宽。
func isCodexProcessTreeRunning() bool {
	switch runtime.GOOS {
	case "darwin", "linux":
		out, err := exec.Command("pgrep", "-f", codexProcessTreePattern()).Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+codexWindowsImageName(), "/NH").Output()
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
	// 先停掉 CDP 注入循环，避免退出/还原期间继续向旧 renderer 写 DOM。
	stopCodexRemoteBrandingInjection()
	if appActionsSuppressed() {
		return // go test 下绝不 kill 本机 Codex 进程
	}
	switch runtime.GOOS {
	case "darwin", "linux":
		// 用进程树检查(含 Resources/codex app-server),确保等到 sqlite 锁释放。
		if !isCodexProcessTreeRunning() {
			return
		}
		killProcessesByPattern(codexProcessTreePattern(), "-TERM")
		if !waitForProcessExit(isCodexProcessTreeRunning, 5*time.Second) {
			killProcessesByPattern(codexProcessTreePattern(), "-9")
			waitForProcessExit(isCodexProcessTreeRunning, 2*time.Second)
		}
		if isCodexProcessTreeRunning() {
			Log("[codex] 警告:Codex 仍在运行,可能影响配置重载")
		}
	case "windows":
		_ = exec.Command("taskkill", "/IM", codexWindowsImageName(), "/T", "/F").Run()
		waitForProcessExit(isCodexProcessTreeRunning, 3*time.Second)
	}
}

// LaunchCodexApp 启动 Codex GUI(尽力而为)。
//
// 仅对桌面 GUI 安装有意义:纯 CLI 没有可"拉起"的常驻进程,headless 执行 codex 二进制(无 TTY)
// 只会起一个立即退出/空转的孤儿进程。故先用 codexGUIInstalled 守卫,纯 CLI 直接跳过。
func LaunchCodexApp() {
	if appActionsSuppressed() {
		return // go test 下绝不 open 本机 Codex
	}
	if !codexGUIInstalled() {
		Log("[codex] 纯 CLI 安装(无桌面 GUI),无需拉起;config 已生效,重开终端即可")
		return
	}
	path := detectCodexGUIPath()
	if path == "" {
		Log("[codex] 未检测到 Codex 安装路径,跳过启动")
		return
	}
	// 远端接管时自动开启临时回环 CDP，用于头像/额度展示；手动皮肤通道开启时
	// 复用其 9335 端口。CLI 分支不附加，codex CLI 不认识这些参数。
	launchPlan := prepareCodexAppLaunchPlan()
	launchArgs := launchPlan.Args
	launched := false
	switch runtime.GOOS {
	case "darwin":
		// detectCodexAppPath 现在优先返回 chrome-native-hosts.json 里的 codexCliPath,
		// 它指向 bundle 内的 CLI 可执行文件(如 .../Codex.app/Contents/Resources/codex),
		// 而非 bundle 主可执行文件。对这种"bundle 内非主可执行文件"路径,`open -a <path>`
		// 会直接以子进程方式运行该 CLI(headless),并不会拉起 GUI —— 表现为"无法唤醒 Codex"。
		// 因此先把路径归一到外层 .app bundle 再 `open`,确保拉起的是 GUI。
		if bundle := codexAppBundlePath(path); strings.HasSuffix(bundle, ".app") {
			openArgs := []string{bundle}
			if len(launchArgs) > 0 {
				openArgs = append(append(openArgs, "--args"), launchArgs...)
			}
			if err := exec.Command("open", openArgs...).Start(); err != nil {
				Log("[codex] 启动 Codex 失败: %v", err)
			} else {
				launched = true
			}
		} else {
			// 独立安装的 CLI(不在 .app 内,无 GUI 可拉起):直接执行。
			if err := exec.Command(path).Start(); err != nil {
				Log("[codex] 启动 Codex 失败: %v", err)
			} else {
				launched = true
			}
		}
	case "windows", "linux":
		cmd := exec.Command(path, launchArgs...)
		// Codex 的 base_url 指向 127.0.0.1。显式绕过系统/环境代理，避免 Clash、
		// Mihomo 等把本地 48800 请求截到自己的端口后返回 503。
		cmd.Env = codexLaunchEnv(os.Environ())
		if err := cmd.Start(); err != nil {
			Log("[codex] 启动 Codex 失败: %v", err)
		} else {
			launched = true
		}
	}
	if launched && launchPlan.Branding {
		startCodexRemoteBrandingInjection(launchPlan.CDPPort)
	}
}

// codexAppBundlePath 把 bundle 内的任意路径归一到外层 .app bundle 路径。
// 例如 /Applications/Codex.app/Contents/Resources/codex → /Applications/Codex.app。
// 非 bundle 内路径(不含 ".app/")原样返回。
func codexAppBundlePath(p string) string {
	if idx := strings.Index(p, ".app/"); idx >= 0 {
		return p[:idx+len(".app")]
	}
	return p
}

// RestartCodexAfterTakeover 退出 → 把全部历史对齐到 targetProvider → 启动。
//
// 这个步骤必须同步执行:Codex 退出前的 app-server 会继续持有旧会话的
// provider/鉴权上下文。如果配置写完就先向 UI 报“接管成功”,用户立即打开
// 旧会话时仍可能走接管前的账号。
//
// 不再只迁移 sourceProvider:旧版接管、其它工具和 Codex 升级都可能留下多个
// provider 值。Cockpit 的启动前修复也是以“当前配置为目标”全量对齐。
// sourceProvider 仅保留给日志和旧调用方,不再用它限制修复范围。
func RestartCodexAfterTakeover(sourceProvider, targetProvider string) (retErr error) {
	defer func() {
		if r := recover(); r != nil {
			Log("[codex] 重启编排 panic: %v", r)
			LaunchCodexApp()
			retErr = fmt.Errorf("Codex 重启编排异常: %v", r)
		}
	}()
	QuitCodexApp()
	summary, err := AlignCodexHistoryVisibility(codexHomeDir(), targetProvider)
	if err != nil {
		// 即使修复失败也把 Codex 拉起,但把失败返回给接管 UI,绝不再显示
		// 假的“已接管”。用户重试时全量对齐是幂等的。
		LaunchCodexApp()
		return fmt.Errorf("对齐 Codex 旧会话失败: %w", err)
	} else {
		Log("[codex] 历史 provider 已全量对齐: %s → %s, rollout=%d sqlite=%d skipped=%v",
			sourceProvider, targetProvider, summary.ChangedRolloutFile, summary.UpdatedSQLiteRows, summary.SkippedSQLite)
	}
	LaunchCodexApp()
	return nil
}

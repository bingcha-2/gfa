package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// ─── Codex 桌面端品牌名(改名兼容)──────────────────────────────────────────
//
// OpenAI 把 Codex 桌面端重新品牌为 ChatGPT。过渡期用户机器上可能是旧名
// Codex.app / Codex.exe,也可能是新名 ChatGPT.app / ChatGPT.exe。为避免到处硬编码
// 单一死名:路径探测统一走候选品牌集合;进程匹配/退出则用「从实际探测到的安装路径反推
// 的真实品牌」,只作用于真正的 Codex 安装,绝不误伤用户那个与 Codex 无关的独立 ChatGPT
// 聊天 app。
//
// 不受改名影响、无需列举的锚点:CLI 可执行名(始终 codex/codex.exe)、配置目录
// (~/.codex)、chrome-native-hosts.json —— 它们是路径/内容锚点,与 app 品牌名无关。

// codexBrandNames 返回桌面端 bundle/exe 的候选品牌名(路径探测用)。
// **新名 ChatGPT 优先**:OpenAI 已把 Codex 桌面端并入 ChatGPT 品牌,存量机器新装的都是
// ChatGPT,先探它命中率更高;旧名 Codex 仅作过渡期兜底。以后再改名只在这里加一项(放最前)。
func codexBrandNames() []string { return []string{"ChatGPT", "Codex"} }

var (
	codexBrandOnce sync.Once
	codexBrandVal  string
)

// codexDesktopBrand 返回本机被接管的 Codex 桌面端真实品牌名(bundle/exe 主名),
// 用于构造 pgrep/tasklist 匹配与 kill 模式。反推不到时回落默认 "Codex"
// (安全方向:宁可漏杀,不可错杀无关的同名 app)。单进程内缓存:app 品牌名运行期间不变。
func codexDesktopBrand() string {
	codexBrandOnce.Do(func() { codexBrandVal = resolveCodexDesktopBrand() })
	if codexBrandVal == "" {
		return "Codex"
	}
	return codexBrandVal
}

func resolveCodexDesktopBrand() string {
	// go test:直接回落默认,既不跑 mdfind 也保证确定性(见 local-tests-no-real-gui 约束)。
	if appActionsSuppressed() {
		return "Codex"
	}
	switch runtime.GOOS {
	case "darwin":
		// 权威来源:chrome-native-hosts.json 的 codexCliPath 指向真正的 Codex 可执行文件,
		// 即便 app 已改名。GUI 安装时它落在 <Brand>.app/Contents/Resources/codex 内。
		if b := codexBrandFromAppPath(detectCodexFromNativeHosts()); b != "" {
			return b
		}
		if b := codexBrandFromAppPath(detectCodexGUIPath()); b != "" {
			return b
		}
	case "windows":
		// GUI exe 与 CLI 分离,品牌名取 GUI 可执行文件主名(Codex.exe→Codex / ChatGPT.exe→ChatGPT)。
		if p := detectCodexGUIPath(); p != "" {
			return strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		}
	case "linux":
		// Linux 桌面端非 .app;沿用旧行为(进程匹配本就依赖 .app 模式,linux 侧为 best-effort)。
		if b := codexBrandFromAppPath(detectCodexFromNativeHosts()); b != "" {
			return b
		}
	}
	return ""
}

// codexBrandFromAppPath 从形如 .../<Brand>.app/... 的路径提取 <Brand>。非 .app 路径返回空。
func codexBrandFromAppPath(p string) string {
	if p == "" {
		return ""
	}
	i := strings.Index(p, ".app")
	if i < 0 {
		return ""
	}
	base := filepath.Base(p[:i]) // .../<Brand> → <Brand>
	for _, candidate := range codexBrandNames() {
		if strings.EqualFold(base, candidate) {
			return candidate
		}
	}
	return base
}

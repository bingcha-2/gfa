package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// detectCodexAppPath 检测任一 Codex 安装路径(GUI 桌面 App 或 CLI)。
// 一个接管按钮管理全部 Codex:CLI 与 App 共享 ~/.codex/config.toml,写一次配置即可同时覆盖。
//
// 优先级:①用户手填的纯 CLI 路径(escape hatch,绝不被自动探测盖过)→ ②ChatGPT 桌面 App
// (OpenAI 已把 Codex 桌面端并入 ChatGPT 品牌,优先识别 App)→ ③纯 CLI 安装兜底。
func detectCodexAppPath() string {
	if p := codexConfiguredCLIOverride(); p != "" {
		return p
	}
	if p := detectCodexGUIPath(); p != "" {
		return p
	}
	return detectCodexCLIPath()
}

// codexConfiguredCLIOverride 返回用户手填的「非 .app 的存在文件」路径(纯 CLI override)。
// GUI 优先探测后,这类手填 CLI 路径若不前置就会被自动探到的桌面 App 盖过 —— 故在总入口最前面兜住。
// .app / GUI .exe 的 override 交给 detectCodexGUIPath 自己校验(含 validatedCodexGUIBundle),不在此处理。
func codexConfiguredCLIOverride() string {
	cfg := LoadConfig()
	if cfg.CodexAppPath == "" || strings.HasSuffix(cfg.CodexAppPath, ".app") {
		return ""
	}
	if info, err := os.Stat(cfg.CodexAppPath); err == nil && !info.IsDir() {
		return cfg.CodexAppPath
	}
	return ""
}

func detectCodexCLIPath() string {
	cfg := LoadConfig()
	if cfg.CodexAppPath != "" {
		if info, err := os.Stat(cfg.CodexAppPath); err == nil && !info.IsDir() && !strings.HasSuffix(cfg.CodexAppPath, ".app") {
			return cfg.CodexAppPath
		}
	}

	// ── 跨平台通用:从 ~/.codex/chrome-native-hosts.json 读取 codexCliPath ──
	// Codex 安装/更新时自动写入此文件,记录了当前可执行文件的真实路径,
	// 无论是 Microsoft Store、手动安装还是 brew install 都适用。
	if p := detectCodexFromNativeHosts(); p != "" {
		return p
	}

	switch runtime.GOOS {
	case "darwin":
		// 桌面端可能已改名(Codex.app → ChatGPT.app),按候选品牌逐个探测 bundle 内 CLI。
		for _, name := range codexBrandNames() {
			if p := detectCodexCLIInAppBundle(spotlightFindApp(name + ".app")); p != "" {
				return p
			}
			if p := detectCodexCLIInAppBundle(filepath.Join("/Applications", name+".app")); p != "" {
				return p
			}
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		appData := os.Getenv("APPDATA")
		userProfile := os.Getenv("USERPROFILE")
		programData := os.Getenv("ProgramData")
		for _, p := range codexWindowsCLICandidates(localAppData, appData, userProfile, programData) {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
		// 新版 Codex CLI 把二进制放进内容寻址子目录 bin\<hash>\codex.exe,直查 bin\codex.exe
		// 命中不到(且纯 CLI 安装不写 chrome-native-hosts.json / 注册表)。扫 bin\* 兜底。
		if p := detectCodexInVersionedBin(localAppData); p != "" {
			return p
		}
	case "linux":
		for _, name := range codexBrandNames() {
			if p := desktopFindApp(name); p != "" {
				return p
			}
			opt := filepath.Join("/opt", name, "codex")
			if info, err := os.Stat(opt); err == nil && !info.IsDir() {
				return opt
			}
		}
		if info, err := os.Stat("/usr/share/codex/codex"); err == nil && !info.IsDir() {
			return "/usr/share/codex/codex"
		}
	}

	// Codex 0.142+ 的官方安装器/包布局会把 CLI 放到
	// ~/.codex/packages/standalone/releases/<version-triple>/bin/codex(.exe)。
	// 这类安装不一定进 PATH,Windows 桌面进程尤其容易漏掉。
	if p := detectCodexInStandalonePackages(codexHomePath(), codexExecutableName()); p != "" {
		return p
	}

	// 纯 CLI 安装兜底:npm -g / brew / 手动软链进 PATH 的 `codex`。这类安装不写
	// chrome-native-hosts.json、不进注册表、也不在上面的固定目录里,仅靠前面的探测会漏检,
	// 导致接管按钮不出现。放在最末位,保证 GUI / 官方安装优先。
	if p := detectCodexOnPath(); p != "" {
		return p
	}
	return ""
}

func detectCodexGUIPath() string {
	cfg := LoadConfig()
	if cfg.CodexAppPath != "" {
		if runtime.GOOS == "darwin" && strings.HasSuffix(cfg.CodexAppPath, ".app") {
			// 只认真实内含 Codex CLI 的 bundle,并归一大小写:override 可能是陈旧路径、
			// 大小写错误(APFS 不敏感)或指向无关的独立 ChatGPT 聊天 app。
			if b := validatedCodexGUIBundle(cfg.CodexAppPath); b != "" {
				return b
			}
		} else if runtime.GOOS == "windows" {
			// 手动指定的桌面端 exe:改名 / 非标准名也认(只排除 CLI codex.exe),避免用户手选后仍被拒。
			if p := codexWindowsGUIOverride(cfg.CodexAppPath); p != "" {
				return p
			}
		}
	}

	// 权威锚点(不认名字):chrome-native-hosts.json 的 codexCliPath 指向真正的 Codex
	// 可执行文件,GUI 安装时它落在 .../<真名>.app/Contents/Resources/codex 内。据此直接反推
	// 出 bundle —— 改名叫 Codex 还是 ChatGPT 都自动识别,无需靠品牌名先后猜测。
	if runtime.GOOS == "darwin" {
		if cli := detectCodexFromNativeHosts(); cli != "" {
			if bundle := codexAppBundlePath(cli); strings.HasSuffix(bundle, ".app") {
				if _, err := os.Stat(bundle); err == nil {
					return bundle
				}
			}
		}
	}

	switch runtime.GOOS {
	case "darwin":
		// 权威锚点缺失时的兜底:桌面端可能已改名(Codex.app → ChatGPT.app),按候选品牌逐个探测。
		// 每个候选都必须真实内含 Codex CLI 才采信 —— 否则改名后同名的独立 ChatGPT 聊天 app
		// 会被误判成 Codex 桌面端(见文件头不变式)。
		for _, name := range codexBrandNames() {
			if b := validatedCodexGUIBundle(spotlightFindApp(name + ".app")); b != "" {
				return b
			}
			if b := validatedCodexGUIBundle(filepath.Join("/Applications", name+".app")); b != "" {
				return b
			}
		}
	case "windows":
		for _, name := range codexBrandNames() {
			loc := registryFindInstallPath(name)
			if loc == "" {
				continue
			}
			info, err := os.Stat(loc)
			if err != nil {
				continue
			}
			if info.IsDir() {
				exe := filepath.Join(loc, name+".exe")
				if exeInfo, exeErr := os.Stat(exe); exeErr == nil && !exeInfo.IsDir() {
					return exe
				}
			} else {
				return loc
			}
		}
		for _, p := range codexWindowsGUIExeCandidates(os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles")) {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	case "linux":
		for _, name := range codexBrandNames() {
			if p := desktopFindApp(name); p != "" {
				return p
			}
			opt := filepath.Join("/opt", name, "codex")
			if info, err := os.Stat(opt); err == nil && !info.IsDir() {
				return opt
			}
		}
		if info, err := os.Stat("/usr/share/codex/codex"); err == nil && !info.IsDir() {
			return "/usr/share/codex/codex"
		}
	}
	return ""
}

func detectCodexCLIInAppBundle(appPath string) string {
	if appPath == "" {
		return ""
	}
	cli := filepath.Join(appPath, "Contents", "Resources", "codex")
	if info, err := os.Stat(cli); err == nil && !info.IsDir() {
		return cli
	}
	return ""
}

// canonicalCaseApp 把 .app 路径的最后一段修正为磁盘上的真实大小写。
// macOS 默认 APFS 大小写不敏感,陈旧 config / 用户手填里可能把 ChatGPT.app 存成 ChatGpt.app,
// os.Stat 照样通过,脏大小写会一路带到 UI 展示、日志与品牌反推。用 ReadDir + EqualFold 归一,
// 在大小写敏感与不敏感文件系统上都确定。读不到父目录 / 无匹配项时原样返回。
func canonicalCaseApp(p string) string {
	dir := filepath.Dir(p)
	base := filepath.Base(p)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return p
	}
	for _, e := range entries {
		if strings.EqualFold(e.Name(), base) {
			return filepath.Join(dir, e.Name())
		}
	}
	return p
}

// validatedCodexGUIBundle 收口 Codex 桌面端的判定不变式:只有"真实内含 Codex CLI"
// (Contents/Resources/codex)的 .app 才算,并返回磁盘真实大小写。config override 与品牌
// 兜底都经它过滤,避免把两类东西误认成 Codex 桌面端:
//   - 与 Codex 无关的独立 ChatGPT 聊天 app(改名后同为 ChatGPT.app,但无 Resources/codex)
//   - 已挪走 / 大小写错误的陈旧路径
//
// 先归一大小写再验内容:大小写敏感文件系统上,mis-cased 输入直接 stat 会落空。
func validatedCodexGUIBundle(app string) string {
	if app == "" || !strings.HasSuffix(app, ".app") {
		return ""
	}
	app = canonicalCaseApp(app)
	if detectCodexCLIInAppBundle(app) == "" {
		return ""
	}
	return app
}

// codexWindowsGUIExeCandidates 返回 Windows 上 Codex 桌面 GUI 的候选可执行文件路径。
// 纯函数(入参为目录根,不碰磁盘/注册表),便于单测。空根目录会被跳过。
// 刻意不含 CLI 的 %LOCALAPPDATA%\OpenAI\Codex\bin\... —— 那是命令行二进制,
// 不能当作"GUI 已安装"的依据,否则纯 CLI 会被误判成 GUI 而触发无意义的 kill/relaunch。
func codexWindowsGUIExeCandidates(localAppData, programFiles string) []string {
	candidates := []string{}
	// 桌面端可能已改名(Codex.exe → ChatGPT.exe),每个候选品牌都列。
	if localAppData != "" {
		// electron-builder NSIS 布局:%LOCALAPPDATA%\Programs\<brand>\<brand>.exe。
		for _, name := range codexBrandNames() {
			candidates = append(candidates, filepath.Join(localAppData, "Programs", name, name+".exe"))
		}
		// Squirrel 布局(Slack/VSCode/Discord 同款):无 Programs 这层,顶层即
		// %LOCALAPPDATA%\<brand>\<brand>.exe(该 exe 是常驻的启动 stub,始终存在)。
		for _, name := range codexBrandNames() {
			candidates = append(candidates, filepath.Join(localAppData, name, name+".exe"))
		}
	}
	if programFiles != "" {
		for _, name := range codexBrandNames() {
			candidates = append(candidates, filepath.Join(programFiles, name, name+".exe"))
		}
	}
	return candidates
}

// codexWindowsGUIOverride 判定用户手动指定的路径能否作为 Windows 桌面端 GUI override。
// 放宽策略:任意**存在的 .exe 文件**都接受(改名 / 非标准名的桌面端也放行),只排除 CLI 二进制
// codex.exe —— 那归 CLI 判定,当成 GUI 会触发无谓的 kill/relaunch。修的是"用户手选了改名后的
// 桌面端 exe,却因名字不是 Codex.exe/ChatGPT.exe 被硬校验拒掉"。纯 stat 逻辑,便于单测。
func codexWindowsGUIOverride(path string) string {
	if !strings.EqualFold(filepath.Ext(path), ".exe") {
		return ""
	}
	if strings.EqualFold(filepath.Base(path), "codex.exe") {
		return ""
	}
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path
	}
	return ""
}

func codexExecutableName() string {
	if runtime.GOOS == "windows" {
		return "codex.exe"
	}
	return "codex"
}

// codexWindowsCLICandidates 返回 Windows 纯 CLI 安装的常见落点。
// npm/pnpm/bun/winget/scoop/choco 的全局 shim 通常在用户目录或包管理器固定目录下,从桌面 App
// 启动时进程 PATH 未必包含它们(尤其"刚装完没重启 App"→PATH 陈旧),所以不能只依赖
// exec.LookPath("codex")——这里把这些固定落点逐个 stat,绕开陈旧 PATH。
func codexWindowsCLICandidates(localAppData, appData, userProfile, programData string) []string {
	candidates := []string{}
	if localAppData != "" {
		candidates = append(candidates,
			filepath.Join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
			filepath.Join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
			// winget 官方安装器的 shim 目录,常年不进已运行进程的 PATH。
			filepath.Join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"),
		)
	}
	if appData != "" {
		candidates = append(candidates,
			filepath.Join(appData, "npm", "codex.cmd"),
			filepath.Join(appData, "pnpm", "codex.cmd"),
		)
	}
	if userProfile != "" {
		candidates = append(candidates,
			filepath.Join(userProfile, ".bun", "bin", "codex.exe"),
			filepath.Join(userProfile, ".bun", "bin", "codex.cmd"),
			// scoop 的 shims 目录。
			filepath.Join(userProfile, "scoop", "shims", "codex.exe"),
			filepath.Join(userProfile, "scoop", "shims", "codex.cmd"),
		)
	}
	if programData != "" {
		// chocolatey 的 shim 目录(机器级安装)。
		candidates = append(candidates, filepath.Join(programData, "chocolatey", "bin", "codex.exe"))
	}
	return candidates
}

// detectCodexOnPath 在 PATH 里找 `codex` 可执行文件(纯 CLI 安装的兜底探测)。
func detectCodexOnPath() string {
	p, err := exec.LookPath("codex")
	if err != nil {
		return ""
	}
	return p
}

// codexGUIInstalled 报告机器上是否安装了 Codex 桌面 GUI(区别于纯 CLI 二进制)。
//
// 接管/还原后是否需要"退出→重启"取决于此:GUI 是常驻进程,启动时把 config.toml 读进内存
// 缓存,改文件后必须重启才会重读;且其历史按 provider 存于 state_5.sqlite,需要 retag。
// 纯 CLI 则每次运行现读 config、历史走 ~/.codex/sessions 的 JSONL,既不需要重启,也没有
// sqlite 历史可对齐。这里只查 GUI 专属安装位置(刻意不含 CLI 的 OpenAI\Codex\bin),避免把
// CLI 误判成 GUI 而去做无意义的 kill/relaunch。
func codexGUIInstalled() bool {
	return detectCodexGUIPath() != ""
}

// detectCodexInVersionedBin 扫描 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe。
// 新版 Codex CLI 用内容寻址哈希子目录存二进制(exe 不在 bin 根层),所以直查 bin\codex.exe
// 会失败。存在多个哈希目录(历史版本残留)时,取 codex.exe 修改时间最新的那个=当前版本。
func detectCodexInVersionedBin(localAppData string) string {
	if localAppData == "" {
		return ""
	}
	binDir := filepath.Join(localAppData, "OpenAI", "Codex", "bin")
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return ""
	}
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		exe := filepath.Join(binDir, e.Name(), "codex.exe")
		info, err := os.Stat(exe)
		if err != nil || info.IsDir() {
			continue
		}
		if mod := info.ModTime(); newest == "" || mod.After(newestMod) {
			newest, newestMod = exe, mod
		}
	}
	return newest
}

// detectCodexInStandalonePackages 扫描 ~/.codex/packages/standalone/releases。
// 兼容两种官方 standalone 布局:
//   - legacy:  releases/<version-triple>/codex(.exe)
//   - package: releases/<version-triple>/bin/codex(.exe)
//
// 多个版本残留时取可执行文件修改时间最新者。
func detectCodexInStandalonePackages(codexHome, exeName string) string {
	if codexHome == "" || exeName == "" {
		return ""
	}
	for _, exe := range []string{
		filepath.Join(codexHome, "packages", "standalone", "current", "bin", exeName),
		filepath.Join(codexHome, "packages", "standalone", "current", exeName),
	} {
		if info, err := os.Stat(exe); err == nil && !info.IsDir() {
			return exe
		}
	}
	releasesDir := filepath.Join(codexHome, "packages", "standalone", "releases")
	entries, err := os.ReadDir(releasesDir)
	if err != nil {
		return ""
	}
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		releaseDir := filepath.Join(releasesDir, e.Name())
		for _, exe := range []string{
			filepath.Join(releaseDir, "bin", exeName),
			filepath.Join(releaseDir, exeName),
		} {
			info, err := os.Stat(exe)
			if err != nil || info.IsDir() {
				continue
			}
			if mod := info.ModTime(); newest == "" || mod.After(newestMod) {
				newest, newestMod = exe, mod
			}
		}
	}
	return newest
}

// ── chrome-native-hosts.json 探测 ──────────────────────────────────────────
//
// Codex 在安装和每次更新时会写入 ~/.codex/chrome-native-hosts.json,
// 其中 chromeNativeHosts[0].codexCliPath 就是当前 codex 可执行文件的真实绝对路径。
// 该机制覆盖 Windows(含 Microsoft Store)、macOS、Linux 三个平台,
// 无需针对每种安装方式硬编码路径。

type nativeHostsFile struct {
	ChromeNativeHosts []struct {
		CodexCliPath string `json:"codexCliPath"`
	} `json:"chromeNativeHosts"`
}

// codexHomePath 返回 ~/.codex 的路径(跨平台)。
func codexHomePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// detectCodexFromNativeHosts 从 ~/.codex/chrome-native-hosts.json 提取 codexCliPath。
// 同时检查 ~/.codex 父目录下的备份位置(LOCALAPPDATA\OpenAI\Codex\chrome-native-hosts.json)。
func detectCodexFromNativeHosts() string {
	candidates := []string{}

	// 主路径: ~/.codex/chrome-native-hosts.json
	if home := codexHomePath(); home != "" {
		candidates = append(candidates, filepath.Join(home, "chrome-native-hosts.json"))
	}

	// Windows 备用: %LOCALAPPDATA%\OpenAI\Codex\chrome-native-hosts.json
	if runtime.GOOS == "windows" {
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			candidates = append(candidates, filepath.Join(localAppData, "OpenAI", "Codex", "chrome-native-hosts.json"))
		}
	}

	for _, path := range candidates {
		if p := parseNativeHostsCodexPath(path); p != "" {
			return p
		}
	}
	return ""
}

// parseNativeHostsCodexPath 解析单个 chrome-native-hosts.json,
// 返回可执行文件路径(已验证存在)。
func parseNativeHostsCodexPath(jsonPath string) string {
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return ""
	}

	var hosts nativeHostsFile
	if err := json.Unmarshal(data, &hosts); err != nil {
		return ""
	}

	for _, h := range hosts.ChromeNativeHosts {
		if h.CodexCliPath == "" {
			continue
		}
		if info, err := os.Stat(h.CodexCliPath); err == nil && !info.IsDir() {
			return h.CodexCliPath
		}
		// codexCliPath 可能指向版本化子目录(如 .../716dda49c14d31a0/codex.exe),
		// 也检查同级 bin 目录下的 codex.exe(非版本化快捷方式)。
		dir := filepath.Dir(h.CodexCliPath)
		parent := filepath.Dir(dir)
		alt := filepath.Join(parent, "codex.exe")
		if alt != h.CodexCliPath {
			if info, err := os.Stat(alt); err == nil && !info.IsDir() {
				return alt
			}
		}
	}
	return ""
}

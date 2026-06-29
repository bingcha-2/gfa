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

// detectCodexAppPath 检测任一 Codex 安装路径(CLI 或 GUI)。
// 一个接管按钮管理全部 Codex:CLI 与 App 共享 ~/.codex/config.toml,写一次配置即可同时覆盖。
func detectCodexAppPath() string {
	if p := detectCodexCLIPath(); p != "" {
		return p
	}
	return detectCodexGUIPath()
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
		if p := detectCodexCLIInAppBundle(spotlightFindApp("Codex.app")); p != "" {
			return p
		}
		if p := detectCodexCLIInAppBundle("/Applications/Codex.app"); p != "" {
			return p
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		appData := os.Getenv("APPDATA")
		userProfile := os.Getenv("USERPROFILE")
		for _, p := range codexWindowsCLICandidates(localAppData, appData, userProfile) {
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
		if p := desktopFindApp("Codex"); p != "" {
			return p
		}
		for _, p := range []string{
			"/opt/Codex/codex",
			"/usr/share/codex/codex",
		} {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
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
			if _, err := os.Stat(cfg.CodexAppPath); err == nil {
				return cfg.CodexAppPath
			}
		} else if runtime.GOOS == "windows" && strings.EqualFold(filepath.Base(cfg.CodexAppPath), "Codex.exe") {
			if info, err := os.Stat(cfg.CodexAppPath); err == nil && !info.IsDir() {
				return cfg.CodexAppPath
			}
		}
	}

	switch runtime.GOOS {
	case "darwin":
		if p := spotlightFindApp("Codex.app"); p != "" {
			return p
		}
		if _, err := os.Stat("/Applications/Codex.app"); err == nil {
			return "/Applications/Codex.app"
		}
	case "windows":
		if loc := registryFindInstallPath("Codex"); loc != "" {
			if info, err := os.Stat(loc); err == nil {
				if info.IsDir() {
					exe := filepath.Join(loc, "Codex.exe")
					if exeInfo, exeErr := os.Stat(exe); exeErr == nil && !exeInfo.IsDir() {
						return exe
					}
				} else {
					return loc
				}
			}
		}
		for _, p := range codexWindowsGUIExeCandidates(os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles")) {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	case "linux":
		if p := desktopFindApp("Codex"); p != "" {
			return p
		}
		for _, p := range []string{"/opt/Codex/codex", "/usr/share/codex/codex"} {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
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

// codexWindowsGUIExeCandidates 返回 Windows 上 Codex 桌面 GUI 的候选可执行文件路径。
// 纯函数(入参为目录根,不碰磁盘/注册表),便于单测。空根目录会被跳过。
// 刻意不含 CLI 的 %LOCALAPPDATA%\OpenAI\Codex\bin\... —— 那是命令行二进制,
// 不能当作"GUI 已安装"的依据,否则纯 CLI 会被误判成 GUI 而触发无意义的 kill/relaunch。
func codexWindowsGUIExeCandidates(localAppData, programFiles string) []string {
	candidates := []string{}
	if localAppData != "" {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", "Codex", "Codex.exe"))
	}
	if programFiles != "" {
		candidates = append(candidates, filepath.Join(programFiles, "Codex", "Codex.exe"))
	}
	return candidates
}

func codexExecutableName() string {
	if runtime.GOOS == "windows" {
		return "codex.exe"
	}
	return "codex"
}

// codexWindowsCLICandidates 返回 Windows 纯 CLI 安装的常见落点。
// npm/pnpm/bun 的全局 shim 通常在用户目录下,从桌面 App 启动时 PATH 未必包含这些目录,
// 所以不能只依赖 exec.LookPath("codex")。
func codexWindowsCLICandidates(localAppData, appData, userProfile string) []string {
	candidates := []string{}
	if localAppData != "" {
		candidates = append(candidates,
			filepath.Join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
			filepath.Join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
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
		)
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

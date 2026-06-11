package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// detectCodexAppPath 检测 Codex 安装路径。
// 优先级: 用户配置 > chrome-native-hosts.json(Codex 自写,跨平台通用)
//        > 注册表/Spotlight/.desktop > 硬编码路径兜底
func detectCodexAppPath() string {
	cfg := LoadConfig()
	if cfg.CodexAppPath != "" {
		if _, err := os.Stat(cfg.CodexAppPath); err == nil {
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
		localAppData := os.Getenv("LOCALAPPDATA")
		programFiles := os.Getenv("ProgramFiles")
		for _, p := range []string{
			filepath.Join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
			filepath.Join(localAppData, "Programs", "Codex", "Codex.exe"),
			filepath.Join(programFiles, "Codex", "Codex.exe"),
		} {
			if p == "" {
				continue
			}
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
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
	return ""
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

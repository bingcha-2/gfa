package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// detectClaudeDesktopPath 检测 Claude 桌面端安装路径(空=未检测到)。
// 优先级:用户自定义路径(逃生口)> 平台自动检测(detectClaudeDesktopPathAuto)。
// 与 codex/antigravity 的「自定义 > 自动」一致 —— 自动检测漏检时用户仍可手动指定,
// 不必让 Claude 先开着才被「进程嗅探」抓到。
func detectClaudeDesktopPath() string {
	if custom := strings.TrimSpace(LoadConfig().ClaudeDesktopPath); custom != "" {
		if _, err := os.Stat(custom); err == nil {
			return custom
		}
	}
	return detectClaudeDesktopPathAuto()
}

// claudeDesktopFromDirs 仅用文件系统定位 Windows 版 Claude Desktop 的 claude.exe，
// 不依赖「进程是否在运行」、不读注册表 —— 把这部分抽成纯函数以便跨平台单测。
// localAppData / programFiles 为对应环境变量(测试可注入);空串表示该根不可用。
// 返回检测到的 exe 路径,未检测到返回 ""。
func claudeDesktopFromDirs(localAppData, programFiles string) string {
	// 策略 1: Squirrel 安装(官方安装器,最常见)。
	if localAppData != "" {
		root := filepath.Join(localAppData, "AnthropicClaude")
		// 1a. 根目录 Squirrel 启动 shim(若存在,路径最稳,不随版本变化)。
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if exe := filepath.Join(root, name); statIsFile(exe) {
				return exe
			}
		}
		// 1b. 版本化子目录 app-<ver>\claude.exe —— 部分版本根目录无 shim,真 exe 只在
		// app-* 里。Glob 升序,取最后一个(字典序最大,通常即最新版本)。这是「关着也能
		// 检测到」的关键:不再依赖进程嗅探。
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if m, _ := filepath.Glob(filepath.Join(root, "app-*", name)); len(m) > 0 {
				return m[len(m)-1]
			}
		}
	}
	// 策略 3: Microsoft Store (MSIX/AppX)。
	if programFiles != "" {
		if m, _ := filepath.Glob(filepath.Join(programFiles, "WindowsApps", "Claude_*", "app", "Claude.exe")); len(m) > 0 {
			return m[len(m)-1]
		}
	}
	// 策略 4: 传统安装器硬编码路径(含大小写变体)。
	for _, c := range legacyClaudeDesktopCandidates(localAppData, programFiles) {
		if statIsFile(c) {
			return c
		}
	}
	return ""
}

func legacyClaudeDesktopCandidates(localAppData, programFiles string) []string {
	var out []string
	if localAppData != "" {
		out = append(out,
			filepath.Join(localAppData, "Programs", "Claude", "Claude.exe"),
			filepath.Join(localAppData, "Programs", "Claude", "claude.exe"),
			filepath.Join(localAppData, "claude-desktop", "Claude.exe"),
			filepath.Join(localAppData, "claude-desktop", "claude.exe"),
		)
	}
	if programFiles != "" {
		out = append(out,
			filepath.Join(programFiles, "Claude", "Claude.exe"),
			filepath.Join(programFiles, "Claude", "claude.exe"),
		)
	}
	return out
}

func statIsFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// isMicrosoftStoreClaude 判断检测到的 Claude Desktop 路径是否为 Microsoft Store(MSIX/AppX)版
// —— 装在 ...\WindowsApps\Claude_*\... 下。Store 版跑在系统沙箱里,接管从机制上做不到:
//   - 既不能按 exe 路径直接 CreateProcess 拉起(Windows 返回 Access is denied),
//   - 包激活(shell:AppsFolder)又不会把接管所需的 env(NODE_EXTRA_CA_CERTS/代理) + argv
//     (--proxy-server)带进容器进程。
//
// 故接管入口据此提前拒绝并引导用户改装独立安装器版,而非硬 exec 撞墙、刷一屏 Access is denied。
// 纯字符串判定(不 stat),跨平台可单测;两种分隔符都归一成 '/'(不靠 filepath.ToSlash ——
// 它只转当前 OS 的分隔符,在 mac 上单测不会转 Windows 的反斜杠)再小写匹配。
func isMicrosoftStoreClaude(path string) bool {
	norm := strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	return strings.Contains(norm, "/windowsapps/")
}

var msixPackageDirRE = regexp.MustCompile(`(?i)/windowsapps/(Claude)_[^_/]+_[^_/]+__([a-z0-9]+)/`)

// msixAppUserModelID 从 ...\WindowsApps\Claude_<ver>_<arch>__<publisherId>\... 推出
// 启动用的 AppUserModelID(Claude_<publisherId>!Claude)。无法识别返回空串。
func msixAppUserModelID(path string) string {
	m := msixPackageDirRE.FindStringSubmatch(strings.ReplaceAll(path, `\`, "/"))
	if m == nil {
		return ""
	}
	return m[1] + "_" + m[2] + "!Claude"
}

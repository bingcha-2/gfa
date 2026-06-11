package main

import (
	"os"
	"path/filepath"
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
// 故接管入口据此提前拒绝并引导用户改装独立安装器版,而非硬 exec 撞墙、刷一屏 Access is denied。
// 纯字符串判定(不 stat),跨平台可单测;两种分隔符都归一成 '/'(不靠 filepath.ToSlash ——
// 它只转当前 OS 的分隔符,在 mac 上单测不会转 Windows 的反斜杠)再小写匹配。
func isMicrosoftStoreClaude(path string) bool {
	norm := strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	return strings.Contains(norm, "/windowsapps/")
}

// claudeMitmRelaunchArgv 构造「带代理重启 Claude 桌面端」的完整 argv(argv[0]=可执行文件)。
// 抽成纯函数以便跨平台单测,且让 Windows/未来其它平台共用同一套参数,避免再漏掉某条通道。
//
// 两条通道:
//   - Node 子进程(Code/Cowork 推理):走 env(HTTPS_PROXY/NODE_EXTRA_CA_CERTS),在调用方设置,
//     与本函数无关、永远生效。
//   - Chromium 渲染进程(登录态/订阅等级/付费墙):不认 env,只认命令行 --proxy-server。
//     仅当 chromiumProxy=true(根 CA 确被信任)才加;否则绝不能加 —— claude.ai 是 UI 主站,
//     被 MITM 但证书不被信任会让整页 ERR_CERT_AUTHORITY_INVALID → 桌面端白屏。
//
// Claude 是 Squirrel 打包:根 claude.exe 是 stub,会把这些参数原样转发给真 Electron 进程,
// 故无需自行解析版本化 exe;exe 传检测到的路径即可。
func claudeMitmRelaunchArgv(exe, proxyAddr string, chromiumProxy bool) []string {
	argv := []string{exe}
	if chromiumProxy {
		argv = append(argv,
			"--proxy-server="+proxyAddr,
			"--proxy-bypass-list=127.0.0.1,localhost",
		)
	}
	return argv
}

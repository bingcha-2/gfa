package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Antigravity 有两个各自独立的桌面 app(对齐 cockpit RuntimeTarget::Ide / ::Legacy):
//   - agIDE:Antigravity IDE(VS Code fork 编辑器)——GFA 历史上只做了这个;
//   - agStandalone:Antigravity(独立版,cockpit 内部叫 legacy)。
//
// 两者注入格式相同(同一套 state.vscdb schema),仅 **app bundle / home 目录 / 进程名**
// 不同,因此可各自独立注入、启停、检测,甚至并发跑不同号。本文件把这些「因 app 而异」的
// 标识集中成 antigravityAppSpec 表,供平台层(local_platform.go / ide_inject.go)按变体解析,
// 避免把 "Antigravity IDE" 硬编码散落各处。
type antigravityAppKind int

const (
	agIDE antigravityAppKind = iota
	agStandalone
)

// antigravityAppSpec 描述一个 Antigravity app 变体在各平台的标识(名称/进程/可执行)。
type antigravityAppSpec struct {
	// Kind 变体。
	Kind antigravityAppKind
	// DisplayName 展示名(前端/日志)。
	DisplayName string
	// SupportDirName 是 macOS「Application Support」与 Win「%APPDATA%」/ Linux「~/.config」下
	// 该 app 的数据目录名(其下 User/globalStorage/state.vscdb)。
	SupportDirName string
	// MacAppBundle 是 macOS /Applications 下的 .app 包名。
	MacAppBundle string
	// WinExeName 是 Windows 可执行名。
	WinExeName string
	// LinuxBin 是 Linux 可执行/命令名。
	LinuxBin string
	// MacProcessPattern 是 pgrep/kill 用的 macOS 主进程锚点(.app/Contents/MacOS 前缀)。
	MacProcessPattern string
}

var antigravityAppSpecs = map[antigravityAppKind]antigravityAppSpec{
	agIDE: {
		Kind:              agIDE,
		DisplayName:       "Antigravity IDE",
		SupportDirName:    "Antigravity IDE",
		MacAppBundle:      "Antigravity IDE.app",
		WinExeName:        "Antigravity IDE.exe",
		LinuxBin:          "antigravity-ide",
		MacProcessPattern: "Antigravity IDE.app/Contents/MacOS",
	},
	agStandalone: {
		Kind:              agStandalone,
		DisplayName:       "Antigravity",
		SupportDirName:    "Antigravity",
		MacAppBundle:      "Antigravity.app",
		WinExeName:        "Antigravity.exe",
		LinuxBin:          "antigravity",
		MacProcessPattern: "Antigravity.app/Contents/MacOS",
	},
}

func antigravitySpec(kind antigravityAppKind) antigravityAppSpec {
	if s, ok := antigravityAppSpecs[kind]; ok {
		return s
	}
	return antigravityAppSpecs[agIDE]
}

// ── 变体化的 app 检测 / 运行态 / 启停(供平台层按变体调用) ──

// detectAntigravityAppPath 探测某变体的安装路径(用 spec 里的各平台名);无则空串。
// 结构对齐旧 detectAntigravityIDEPath,但按变体参数化;IDE 变体额外认用户自定义 IDEPath。
func detectAntigravityAppPath(kind antigravityAppKind) string {
	spec := antigravitySpec(kind)
	if kind == agIDE {
		if cfg := LoadConfig(); cfg.IDEPath != "" {
			if _, err := os.Stat(cfg.IDEPath); err == nil {
				return cfg.IDEPath
			}
		}
	}
	switch runtime.GOOS {
	case "windows":
		if loc := registryFindInstallPath(spec.DisplayName); loc != "" {
			if strings.HasSuffix(strings.ToLower(loc), ".exe") {
				if info, err := os.Stat(loc); err == nil && !info.IsDir() {
					return loc
				}
			}
			exe := filepath.Join(loc, spec.WinExeName)
			if info, err := os.Stat(exe); err == nil && !info.IsDir() {
				return exe
			}
		}
		for _, base := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles")} {
			if base == "" {
				continue
			}
			p := filepath.Join(base, "Programs", spec.DisplayName, spec.WinExeName)
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	case "darwin":
		if p := spotlightFindApp(spec.MacAppBundle); p != "" {
			return p
		}
		if p := filepath.Join("/Applications", spec.MacAppBundle); dirExists(p) {
			return p
		}
	case "linux":
		if p := desktopFindApp(spec.DisplayName); p != "" {
			return p
		}
		for _, p := range []string{
			filepath.Join("/usr/share", spec.LinuxBin, spec.LinuxBin),
			filepath.Join("/opt", spec.DisplayName, spec.LinuxBin),
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// isAntigravityAppRunning 报告某变体是否在运行。各平台锚点用 spec 里的独立标识,
// 保证 IDE 与独立版互不误判(darwin 用 .app/Contents/MacOS 前缀、win 用精确 IMAGENAME)。
func isAntigravityAppRunning(kind antigravityAppKind) bool {
	spec := antigravitySpec(kind)
	switch runtime.GOOS {
	case "darwin":
		out, err := hideCmd("pgrep", "-f", spec.MacProcessPattern).Output()
		return err == nil && strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := hideCmd("tasklist", "/FI", "IMAGENAME eq "+spec.WinExeName, "/NH").Output()
		return err == nil && !strings.Contains(string(out), "No tasks")
	case "linux":
		out, err := hideCmd("pgrep", "-f", spec.LinuxBin).Output()
		return err == nil && strings.TrimSpace(string(out)) != ""
	default:
		return false
	}
}

// launchAntigravityApp 拉起某变体(未检测到安装路径则报错)。
func launchAntigravityApp(kind antigravityAppKind) error {
	spec := antigravitySpec(kind)
	appPath := detectAntigravityAppPath(kind)
	if appPath == "" {
		return fmt.Errorf("未检测到 %s 安装路径", spec.DisplayName)
	}
	Log("[antigravity] 正在启动 %s...", spec.DisplayName)
	return launchApp(appPath)
}

// stopAntigravityApp 停某变体进程(SIGTERM,必要时 SIGKILL / 强制 taskkill)。
// 进程锚点用 spec,避免误杀另一变体或无关进程。
func stopAntigravityApp(kind antigravityAppKind) error {
	if appActionsSuppressed() {
		return nil // go test 下绝不 kill 本机进程
	}
	spec := antigravitySpec(kind)
	running := func() bool { return isAntigravityAppRunning(kind) }
	switch runtime.GOOS {
	case "darwin":
		killProcessesByPattern(spec.MacProcessPattern, "-TERM")
		if !waitForProcessExit(running, 5*time.Second) {
			killProcessesByPattern(spec.MacProcessPattern, "-9")
		}
	case "windows":
		_ = hideCmd("taskkill", "/IM", spec.WinExeName, "/T").Run()
		if !waitForProcessExit(running, 5*time.Second) {
			_ = hideCmd("taskkill", "/IM", spec.WinExeName, "/T", "/F").Run()
		}
	case "linux":
		_ = hideCmd("pkill", "-TERM", "-f", spec.LinuxBin).Run()
		waitForProcessExit(running, 3*time.Second)
	}
	return nil
}

// antigravityGlobalStorageDir 纯路径构造(不 Stat):返回某变体的 User/globalStorage 目录。
// 各平台位置对齐 cockpit,仅 SupportDirName 因 app 而异。
func antigravityGlobalStorageDir(kind antigravityAppKind) string {
	dir := antigravitySpec(kind).SupportDirName
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(os.Getenv("HOME"), "Library", "Application Support", dir, "User", "globalStorage")
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			appdata = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
		return filepath.Join(appdata, dir, "User", "globalStorage")
	default:
		return filepath.Join(os.Getenv("HOME"), ".config", dir, "User", "globalStorage")
	}
}

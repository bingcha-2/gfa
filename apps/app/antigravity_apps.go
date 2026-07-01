package main

import (
	"os"
	"path/filepath"
	"runtime"
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

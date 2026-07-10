package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ── 机器级真实浏览器防封 ──────────────────────────────────────────────────────
// 接管时(任意目标,含 CLI-only)把本机所有 Chromium 系浏览器(Chrome/Edge/Brave/
// Chromium)的每个 profile 都写上 WebRTC/地理位置阻断策略 —— 与「接管哪个 Claude 客户端」
// 解耦,盖住「用户用真实浏览器登录 Claude 时经 WebRTC 泄真 IP」这个面。取消接管逐个还原。
// 复用 host_browser_preferences.go 的 Chromium Preferences(JSON)读写与 WebRTC/geo 键。

// browserProfileBackup 记录单个浏览器 profile 接管前的 WebRTC/地理位置原值,供干净还原。
type browserProfileBackup struct {
	Browser     string               `json:"browser"` // chrome / edge / brave / chromium
	Path        string               `json:"path"`
	HadFile     bool                 `json:"hadFile"`
	Perm        uint32               `json:"perm,omitempty"`
	WebRTC      hostPreferenceBackup `json:"webrtc"`
	Geolocation hostPreferenceBackup `json:"geolocation"`
}

// chromiumBrowser 描述一款 Chromium 系浏览器的 User Data 根 + 进程名(杀进程用)。
type chromiumBrowser struct {
	Name      string
	UserData  string
	Processes []string
}

// chromiumBrowsers 按当前 OS 返回本机可能存在的 Chromium 系浏览器 User Data 根。
// 测试(origConfigDir 非空)只返回临时目录里的伪浏览器,绝不触碰开发机真实 profile。
func chromiumBrowsers() []chromiumBrowser {
	if origConfigDir != "" {
		return []chromiumBrowser{{Name: "chrome", UserData: filepath.Join(origConfigDir, "test-chrome", "User Data"), Processes: []string{"test-chrome"}}}
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		return []chromiumBrowser{
			{"chrome", filepath.Join(local, "Google", "Chrome", "User Data"), []string{"chrome.exe"}},
			{"edge", filepath.Join(local, "Microsoft", "Edge", "User Data"), []string{"msedge.exe"}},
			{"brave", filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data"), []string{"brave.exe"}},
			{"chromium", filepath.Join(local, "Chromium", "User Data"), []string{"chromium.exe"}},
		}
	case "darwin":
		as := filepath.Join(home, "Library", "Application Support")
		return []chromiumBrowser{
			{"chrome", filepath.Join(as, "Google", "Chrome"), []string{"Google Chrome"}},
			{"edge", filepath.Join(as, "Microsoft Edge"), []string{"Microsoft Edge"}},
			{"brave", filepath.Join(as, "BraveSoftware", "Brave-Browser"), []string{"Brave Browser"}},
			{"chromium", filepath.Join(as, "Chromium"), []string{"Chromium"}},
		}
	default: // linux 及其它类 unix
		cfg := filepath.Join(home, ".config")
		return []chromiumBrowser{
			{"chrome", filepath.Join(cfg, "google-chrome"), []string{"chrome"}},
			{"edge", filepath.Join(cfg, "microsoft-edge"), []string{"msedge"}},
			{"brave", filepath.Join(cfg, "BraveSoftware", "Brave-Browser"), []string{"brave"}},
			{"chromium", filepath.Join(cfg, "chromium"), []string{"chromium"}},
		}
	}
}

// chromiumProfilePrefsPaths 枚举一个 User Data 根下所有已存在的 profile Preferences 文件。
// 只碰已存在的 profile;不为没跑过的浏览器凭空造 Preferences(更安全、还原永远是回写而非删)。
func chromiumProfilePrefsPaths(userData string) []string {
	entries, err := os.ReadDir(userData)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if name != "Default" && name != "Guest Profile" && !strings.HasPrefix(name, "Profile ") {
			continue
		}
		p := filepath.Join(userData, name, "Preferences")
		if _, statErr := os.Stat(p); statErr == nil {
			out = append(out, p)
		}
	}
	return out
}

// captureHostChromiumProfiles 发现本机所有 Chromium 系 profile,备份各自 WebRTC/地理位置原值到快照。
func captureHostChromiumProfiles(snap *hostProtectionSnapshot) error {
	if !snap.BlockWebRTC && !snap.BlockGeolocation {
		return nil
	}
	var backups []browserProfileBackup
	for _, br := range chromiumBrowsers() {
		for _, prefsPath := range chromiumProfilePrefsPaths(br.UserData) {
			root, hadFile, perm, err := readHostPreferenceDocument(prefsPath)
			if err != nil {
				continue // 单个 profile 读失败不阻塞整体接管
			}
			b := browserProfileBackup{Browser: br.Name, Path: prefsPath, HadFile: hadFile, Perm: uint32(perm)}
			if snap.BlockWebRTC {
				if b.WebRTC, err = captureHostPreference(root, hostWebRTCPreferencePath); err != nil {
					continue
				}
			}
			if snap.BlockGeolocation {
				if b.Geolocation, err = captureHostPreference(root, hostGeolocationPreferencePath); err != nil {
					continue
				}
			}
			backups = append(backups, b)
		}
	}
	snap.BrowserProfiles = backups
	return nil
}

// applyHostChromiumProfiles 先关掉运行中的浏览器(否则退出会用内存态覆盖),再逐个写入阻断策略。
// 返回实际写入成功的 profile 数。
func applyHostChromiumProfiles(snap *hostProtectionSnapshot) int {
	if len(snap.BrowserProfiles) == 0 {
		return 0
	}
	killChromiumBrowsers(snap.BrowserProfiles)
	applied := 0
	for i := range snap.BrowserProfiles {
		b := &snap.BrowserProfiles[i]
		root, _, perm, err := readHostPreferenceDocument(b.Path)
		if err != nil {
			continue
		}
		if b.Perm != 0 {
			perm = os.FileMode(b.Perm)
		}
		if snap.BlockWebRTC {
			setHostNestedPreference(root, hostWebRTCPreferencePath, "disable_non_proxied_udp")
		}
		if snap.BlockGeolocation {
			setHostNestedPreference(root, hostGeolocationPreferencePath, 2) // Chromium CONTENT_SETTING_BLOCK
		}
		if err := writeHostPreferenceDocument(b.Path, root, perm); err != nil {
			continue
		}
		applied++
	}
	return applied
}

// restoreHostChromiumProfiles 逐个把 profile 的 WebRTC/地理位置改回接管前原值。返回还原成功数。
// 还原也要先关浏览器,否则浏览器退出时又把阻断值写回去。
func restoreHostChromiumProfiles(snap *hostProtectionSnapshot) int {
	if len(snap.BrowserProfiles) == 0 {
		return 0
	}
	killChromiumBrowsers(snap.BrowserProfiles)
	restored := 0
	for i := range snap.BrowserProfiles {
		b := &snap.BrowserProfiles[i]
		root, exists, perm, err := readHostPreferenceDocument(b.Path)
		if err != nil || !exists {
			continue
		}
		if b.Perm != 0 {
			perm = os.FileMode(b.Perm)
		}
		if snap.BlockWebRTC {
			if err := restoreHostPreference(root, hostWebRTCPreferencePath, b.WebRTC); err != nil {
				continue
			}
		}
		if snap.BlockGeolocation {
			if err := restoreHostPreference(root, hostGeolocationPreferencePath, b.Geolocation); err != nil {
				continue
			}
		}
		if err := writeHostPreferenceDocument(b.Path, root, perm); err != nil {
			continue
		}
		restored++
	}
	return restored
}

// killChromiumBrowsers 关闭快照涉及的浏览器进程(按进程名去重)。测试抑制态下绝不触碰真机。
func killChromiumBrowsers(profiles []browserProfileBackup) {
	if appActionsSuppressed() || len(profiles) == 0 {
		return
	}
	procByBrowser := map[string][]string{}
	for _, br := range chromiumBrowsers() {
		procByBrowser[br.Name] = br.Processes
	}
	seen := map[string]bool{}
	for _, p := range profiles {
		for _, proc := range procByBrowser[p.Browser] {
			if seen[proc] {
				continue
			}
			seen[proc] = true
			killProcessByName(proc)
		}
	}
}

// browserProfilesSummary 把 profile 列表按浏览器计数拼成日志片段,如 "chrome×2 edge×1";空则 "无"。
func browserProfilesSummary(profiles []browserProfileBackup) string {
	if len(profiles) == 0 {
		return "无"
	}
	counts := map[string]int{}
	order := make([]string, 0, len(profiles))
	for _, p := range profiles {
		if counts[p.Browser] == 0 {
			order = append(order, p.Browser)
		}
		counts[p.Browser]++
	}
	parts := make([]string, 0, len(order))
	for _, name := range order {
		parts = append(parts, fmt.Sprintf("%s×%d", name, counts[name]))
	}
	return strings.Join(parts, " ")
}

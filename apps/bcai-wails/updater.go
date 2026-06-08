package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// 当前版本（构建时通过 ldflags 注入）
var AppVersion = "8.7.0"

var (
	// UpdateCheckURL 可通过环境变量 BCAI_UPDATE_URL 覆盖（本地开发用）
	// 默认走主域名 bcai.lol，请求失败自动回退到备域名 bcai.space（见 bcai_hosts.go）
	UpdateCheckURL  = getEnvOrDefault("BCAI_UPDATE_URL", "https://bcai.lol/updates/latest-wails.json")
	UpdateCheckFreq = 30 * time.Minute
)

// ─── Update Info ─────────────────────────────────────────────────────────

// PlatformAsset 平台特定的下载资源
type PlatformAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type UpdateInfo struct {
	Version   string `json:"version"`
	URL       string `json:"url"`        // Windows 默认下载地址（向后兼容）
	SHA256    string `json:"sha256"`     // 校验和
	Size      int64  `json:"size"`       // 文件大小
	Changelog string `json:"changelog"`  // 更新日志
	MinVer    string `json:"minVersion"` // 最低支持版本（低于此版本强制更新）

	// 平台特定资源
	MacOS map[string]PlatformAsset `json:"macOS"`
	Linux map[string]PlatformAsset `json:"linux"`
}

// resolveAsset 根据当前平台和架构选择正确的下载资源
func (info *UpdateInfo) resolveAsset() (downloadURL, checksum string, size int64, err error) {
	arch := runtime.GOARCH

	switch runtime.GOOS {
	case "darwin":
		if info.MacOS != nil {
			if asset, ok := info.MacOS[arch]; ok && asset.URL != "" {
				return asset.URL, asset.SHA256, asset.Size, nil
			}
		}
		return "", "", 0, fmt.Errorf("manifest 中没有 macOS/%s 的下载地址", arch)
	case "linux":
		if info.Linux != nil {
			if asset, ok := info.Linux[arch]; ok && asset.URL != "" {
				return asset.URL, asset.SHA256, asset.Size, nil
			}
		}
		return "", "", 0, fmt.Errorf("manifest 中没有 Linux/%s 的下载地址", arch)
	default: // windows
		if info.URL == "" {
			return "", "", 0, fmt.Errorf("manifest 中没有 Windows 下载地址")
		}
		return info.URL, info.SHA256, info.Size, nil
	}
}

type UpdateStatus struct {
	Status    string  `json:"status"` // checking, available, downloading, ready, up-to-date, error
	Version   string  `json:"version"`
	Current   string  `json:"current"`
	Changelog string  `json:"changelog"`
	Percent   float64 `json:"percent"`
	Error     string  `json:"error"`
	CanSkip   bool    `json:"canSkip"` // 是否可以跳过
}

// ─── Updater ─────────────────────────────────────────────────────────────

type Updater struct {
	mu      sync.RWMutex
	status  UpdateStatus
	info    *UpdateInfo
	stopCh  chan struct{}
	running bool
	exePath string // 当前 exe 路径
}

var (
	updaterOnce     sync.Once
	updaterInstance *Updater
)

func GetUpdater() *Updater {
	updaterOnce.Do(func() {
		exePath, _ := os.Executable()
		updaterInstance = &Updater{
			status: UpdateStatus{
				Status:  "idle",
				Current: AppVersion,
			},
			exePath: exePath,
		}
	})
	return updaterInstance
}

// updaterHttpDo 执行 HTTP 请求：依次尝试主域名 → 备域名（bcai_hosts.go），
// 每个域名内部再做 直连 → 代理 回退。仅 GET（无 body），每次重建 request。
func updaterHttpDo(req *http.Request) (*http.Response, error) {
	cfg := LoadConfig()
	var lastErr error
	for _, rawURL := range bcaiURLCandidates(req.URL.String()) {
		// 直连（和 leaser 等对 bcai 的请求保持一致）
		directReq, err := http.NewRequest(req.Method, rawURL, nil)
		if err != nil {
			lastErr = err
			continue
		}
		directReq.Header = req.Header
		if resp, derr := createBcaiClient().Do(directReq); derr == nil {
			return resp, nil
		} else {
			Log("[updater] Direct request to %s failed (%v), retrying via proxy...", rawURL, derr)
			lastErr = derr
		}

		// 回退到系统代理 / 用户配置的上游代理
		proxyReq, err := http.NewRequest(req.Method, rawURL, nil)
		if err != nil {
			lastErr = err
			continue
		}
		proxyReq.Header = req.Header
		if resp, perr := createHttpClient(cfg.UpstreamProxy).Do(proxyReq); perr == nil {
			return resp, nil
		} else {
			Log("[updater] Proxy request to %s failed (%v)", rawURL, perr)
			lastErr = perr
		}
	}
	return nil, lastErr
}

// Start 启动自动检查更新（后台循环）
func (u *Updater) Start() {
	u.mu.Lock()
	if u.running {
		u.mu.Unlock()
		return
	}
	u.running = true
	u.stopCh = make(chan struct{})
	u.mu.Unlock()

	Log("[updater] Auto-update started (current: v%s)", AppVersion)

	go func() {
		// 启动后 10 秒检查一次
		select {
		case <-time.After(10 * time.Second):
			u.CheckForUpdate()
		case <-u.stopCh:
			return
		}

		// 之后每 30 分钟检查
		ticker := time.NewTicker(UpdateCheckFreq)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				u.CheckForUpdate()
			case <-u.stopCh:
				return
			}
		}
	}()
}

// Stop 停止自动检查
func (u *Updater) Stop() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.running {
		close(u.stopCh)
		u.running = false
	}
}

// GetStatus 获取当前更新状态
func (u *Updater) GetStatus() UpdateStatus {
	u.mu.RLock()
	defer u.mu.RUnlock()
	s := u.status
	s.Current = AppVersion
	return s
}

func (u *Updater) setStatus(s UpdateStatus) {
	u.mu.Lock()
	s.Current = AppVersion
	u.status = s
	u.mu.Unlock()
}

// CheckForUpdate 检查是否有新版本
func (u *Updater) CheckForUpdate() *UpdateInfo {
	u.setStatus(UpdateStatus{Status: "checking"})
	Log("[updater] Checking for updates... (platform: %s/%s)", runtime.GOOS, runtime.GOARCH)

	req, err := http.NewRequest("GET", UpdateCheckURL, nil)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Error: err.Error()})
		return nil
	}
	req.Header.Set("User-Agent", fmt.Sprintf("BingchaAI/%s (%s/%s)", AppVersion, runtime.GOOS, runtime.GOARCH))

	resp, err := updaterHttpDo(req)
	if err != nil {
		Log("[updater] Check failed: %v", err)
		u.setStatus(UpdateStatus{Status: "error", Error: fmt.Sprintf("网络错误: %v", err)})
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		// 更新清单文件尚未部署，视为已是最新
		Log("[updater] Update manifest not found (404), treating as up-to-date")
		u.setStatus(UpdateStatus{Status: "up-to-date", Version: AppVersion})
		return nil
	}
	if resp.StatusCode != 200 {
		Log("[updater] Check failed: HTTP %d", resp.StatusCode)
		u.setStatus(UpdateStatus{Status: "error", Error: fmt.Sprintf("服务器返回 %d", resp.StatusCode)})
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1MB max
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Error: err.Error()})
		return nil
	}

	var info UpdateInfo
	if err := json.Unmarshal(body, &info); err != nil {
		Log("[updater] Invalid response: %v", err)
		u.setStatus(UpdateStatus{Status: "error", Error: "更新信息格式错误"})
		return nil
	}

	if !isNewerVersion(info.Version, AppVersion) {
		Log("[updater] Already up to date (v%s)", AppVersion)
		u.setStatus(UpdateStatus{Status: "up-to-date", Version: AppVersion})
		return nil
	}

	// 检查当前平台是否有对应的下载资源
	if _, _, _, assetErr := info.resolveAsset(); assetErr != nil {
		Log("[updater] New version v%s available but no asset for %s/%s: %v", info.Version, runtime.GOOS, runtime.GOARCH, assetErr)
		u.setStatus(UpdateStatus{Status: "up-to-date", Version: AppVersion})
		return nil
	}

	Log("[updater] New version available: v%s (current: v%s)", info.Version, AppVersion)
	u.mu.Lock()
	u.info = &info
	u.status = UpdateStatus{
		Status:    "available",
		Version:   info.Version,
		Changelog: info.Changelog,
		CanSkip:   !isNewerVersion(info.MinVer, AppVersion), // 如果当前版本低于 MinVer，不可跳过
	}
	u.mu.Unlock()

	return &info
}

// DownloadAndApply 下载新版本并准备替换
func (u *Updater) DownloadAndApply() error {
	u.mu.RLock()
	info := u.info
	u.mu.RUnlock()

	if info == nil {
		return fmt.Errorf("没有可用的更新")
	}

	downloadURL, expectedHash, expectedSize, err := info.resolveAsset()
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: err.Error()})
		return err
	}

	Log("[updater] Downloading v%s from %s (platform: %s/%s)", info.Version, downloadURL, runtime.GOOS, runtime.GOARCH)
	u.setStatus(UpdateStatus{
		Status:  "downloading",
		Version: info.Version,
		Percent: 0,
	})

	// 下载到临时目录
	tmpDir := os.TempDir()
	ext := ".tmp"
	if runtime.GOOS == "darwin" {
		ext = ".dmg"
	} else if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	tmpFile := filepath.Join(tmpDir, fmt.Sprintf("bcai-update-%s%s", info.Version, ext))
	defer func() {
		// 如果更新失败，清理临时文件
		u.mu.RLock()
		status := u.status.Status
		u.mu.RUnlock()
		if status == "error" {
			_ = os.Remove(tmpFile)
		}
	}()

	req, err := http.NewRequest("GET", downloadURL, nil)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("请求创建失败: %v", err)})
		return err
	}
	req.Header.Set("User-Agent", fmt.Sprintf("BingchaAI/%s (%s/%s)", AppVersion, runtime.GOOS, runtime.GOARCH))

	resp, err := updaterHttpDo(req)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("下载失败: %v", err)})
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("下载失败: HTTP %d", resp.StatusCode)})
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(tmpFile)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("创建临时文件失败: %v", err)})
		return err
	}

	totalSize := resp.ContentLength
	if totalSize <= 0 && expectedSize > 0 {
		totalSize = expectedSize
	}

	hasher := sha256.New()
	var written int64
	buf := make([]byte, 64*1024)
	lastReport := time.Now()

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, wErr := f.Write(buf[:n]); wErr != nil {
				f.Close()
				u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("写入失败: %v", wErr)})
				return wErr
			}
			hasher.Write(buf[:n])
			written += int64(n)

			// 每 200ms 更新一次进度
			if time.Since(lastReport) > 200*time.Millisecond && totalSize > 0 {
				pct := float64(written) / float64(totalSize) * 100
				u.setStatus(UpdateStatus{
					Status:  "downloading",
					Version: info.Version,
					Percent: pct,
				})
				lastReport = time.Now()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			f.Close()
			u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("下载中断: %v", readErr)})
			return readErr
		}
	}
	f.Close()

	Log("[updater] Download complete: %d bytes", written)

	// SHA256 校验
	if expectedHash != "" {
		actualHash := strings.ToUpper(hex.EncodeToString(hasher.Sum(nil)))
		expectedUpper := strings.ToUpper(expectedHash)
		if actualHash != expectedUpper {
			errMsg := fmt.Sprintf("SHA256 校验失败: 期望 %s, 实际 %s", expectedUpper[:16]+"...", actualHash[:16]+"...")
			Log("[updater] %s", errMsg)
			u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: errMsg})
			return fmt.Errorf("%s", errMsg)
		}
		Log("[updater] SHA256 verified OK")
	}

	// 根据平台执行不同的安装策略
	if runtime.GOOS == "darwin" {
		return u.applyMacOSUpdate(tmpFile, info)
	}
	return u.applyWindowsLinuxUpdate(tmpFile, info)
}

// applyMacOSUpdate macOS: 挂载 DMG，拷贝 .app 到原位置，卸载 DMG
func (u *Updater) applyMacOSUpdate(dmgPath string, info *UpdateInfo) error {
	Log("[updater] Applying macOS update from DMG: %s", dmgPath)

	// 1. 找到当前 .app bundle 的路径
	appBundlePath := findAppBundlePath(u.exePath)
	if appBundlePath == "" {
		errMsg := "无法定位当前 .app 路径"
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: errMsg})
		return fmt.Errorf("%s", errMsg)
	}
	Log("[updater] Current app bundle: %s", appBundlePath)

	// 2. 挂载 DMG
	mountPoint := filepath.Join(os.TempDir(), "bcai-update-mount")
	_ = os.MkdirAll(mountPoint, 0755)
	// 先尝试卸载残留
	_ = exec.Command("hdiutil", "detach", mountPoint, "-force").Run()

	mountCmd := exec.Command("hdiutil", "attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-noautoopen")
	mountOut, err := mountCmd.CombinedOutput()
	if err != nil {
		errMsg := fmt.Sprintf("挂载 DMG 失败: %v\n%s", err, string(mountOut))
		Log("[updater] %s", errMsg)
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: "挂载 DMG 失败"})
		return fmt.Errorf("%s", errMsg)
	}
	defer func() {
		_ = exec.Command("hdiutil", "detach", mountPoint, "-force").Run()
		_ = os.Remove(dmgPath)
	}()
	Log("[updater] DMG mounted at %s", mountPoint)

	// 3. 在挂载卷中找到 .app
	entries, err := os.ReadDir(mountPoint)
	if err != nil {
		errMsg := fmt.Sprintf("读取 DMG 内容失败: %v", err)
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: errMsg})
		return fmt.Errorf("%s", errMsg)
	}

	var sourceApp string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".app") {
			sourceApp = filepath.Join(mountPoint, entry.Name())
			break
		}
	}
	if sourceApp == "" {
		errMsg := "DMG 中未找到 .app 文件"
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: errMsg})
		return fmt.Errorf("%s", errMsg)
	}
	Log("[updater] Found app in DMG: %s", sourceApp)

	// 4. 备份旧 .app，然后用新 .app 替换
	backupPath := appBundlePath + ".old"
	_ = os.RemoveAll(backupPath)

	if err := os.Rename(appBundlePath, backupPath); err != nil {
		// 可能没权限，尝试用 osascript 提权
		Log("[updater] Rename failed (%v), trying with admin privileges...", err)
		script := fmt.Sprintf(`do shell script "rm -rf %q && cp -R %q %q" with administrator privileges`,
			appBundlePath, sourceApp, appBundlePath)
		adminCmd := exec.Command("osascript", "-e", script)
		if adminOut, adminErr := adminCmd.CombinedOutput(); adminErr != nil {
			errMsg := fmt.Sprintf("替换应用失败（需要管理员权限）: %v\n%s", adminErr, string(adminOut))
			u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: "替换应用失败，权限不足"})
			return fmt.Errorf("%s", errMsg)
		}
	} else {
		// rename 成功，用 cp -R 复制新 .app
		cpCmd := exec.Command("cp", "-R", sourceApp, appBundlePath)
		if cpOut, cpErr := cpCmd.CombinedOutput(); cpErr != nil {
			// 回滚
			Log("[updater] Copy failed, rolling back: %v\n%s", cpErr, string(cpOut))
			_ = os.Rename(backupPath, appBundlePath)
			errMsg := fmt.Sprintf("复制新版本失败: %v", cpErr)
			u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: errMsg})
			return fmt.Errorf("%s", errMsg)
		}
		// 清理备份
		_ = os.RemoveAll(backupPath)
	}

	// 5. 清除 macOS quarantine 属性（从 DMG 复制的文件可能带有此属性）
	_ = exec.Command("xattr", "-rd", "com.apple.quarantine", appBundlePath).Run()

	Log("[updater] macOS update applied: v%s → v%s", AppVersion, info.Version)
	u.setStatus(UpdateStatus{
		Status:    "ready",
		Version:   info.Version,
		Changelog: info.Changelog,
	})

	// 自动重启
	Log("[updater] Auto-restarting to apply update...")
	time.Sleep(1 * time.Second)
	u.RestartApp()

	return nil
}

// applyWindowsLinuxUpdate Windows/Linux: 直接替换 exe 二进制
func (u *Updater) applyWindowsLinuxUpdate(tmpFile string, info *UpdateInfo) error {
	// 替换当前 exe
	// Windows: 不能直接替换正在运行的 exe，使用 rename 策略
	oldExe := u.exePath + ".old"
	_ = os.Remove(oldExe) // 清理上次残留的 .old

	// 设置可执行权限（Linux）
	if runtime.GOOS == "linux" {
		_ = os.Chmod(tmpFile, 0755)
	}

	// 1. 把当前 exe 重命名为 .old
	if err := os.Rename(u.exePath, oldExe); err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("替换失败(rename): %v", err)})
		return fmt.Errorf("rename current exe: %w", err)
	}

	// 2. 把下载的临时文件移到 exe 位置
	if err := os.Rename(tmpFile, u.exePath); err != nil {
		// 回滚
		_ = os.Rename(oldExe, u.exePath)
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("替换失败(move): %v", err)})
		return fmt.Errorf("move new exe: %w", err)
	}

	Log("[updater] Update applied: v%s → v%s", AppVersion, info.Version)
	u.setStatus(UpdateStatus{
		Status:    "ready",
		Version:   info.Version,
		Changelog: info.Changelog,
	})

	// 自动重启以应用更新
	Log("[updater] Auto-restarting to apply update...")
	time.Sleep(1 * time.Second) // 给前端一点时间显示状态
	u.RestartApp()

	return nil
}

// RestartApp 重启应用以应用更新
func (u *Updater) RestartApp() error {
	Log("[updater] Restarting application...")

	// 保存统计数据
	GetUsageStats().Save()

	if runtime.GOOS == "darwin" {
		// macOS: 用 open 命令启动 .app bundle
		appBundlePath := findAppBundlePath(u.exePath)
		if appBundlePath != "" {
			cmd := exec.Command("open", "-a", appBundlePath)
			if err := cmd.Start(); err != nil {
				Log("[updater] open -a failed: %v, trying direct exec...", err)
				// 降级：直接启动二进制
				cmd2 := exec.Command(u.exePath)
				cmd2.Dir = filepath.Dir(u.exePath)
				_ = cmd2.Start()
			}
		} else {
			cmd := exec.Command(u.exePath)
			cmd.Dir = filepath.Dir(u.exePath)
			_ = cmd.Start()
		}
	} else {
		cmd := exec.Command(u.exePath)
		cmd.Dir = filepath.Dir(u.exePath)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("restart failed: %w", err)
		}
	}

	// 退出当前进程
	os.Exit(0)
	return nil
}

// CleanupOldBinary 启动时清理上次更新残留的 .old 文件
func (u *Updater) CleanupOldBinary() {
	oldExe := u.exePath + ".old"
	if _, err := os.Stat(oldExe); err == nil {
		if err := os.Remove(oldExe); err != nil {
			Log("[updater] Failed to cleanup old binary: %v", err)
		} else {
			Log("[updater] Cleaned up old binary")
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// findAppBundlePath 从二进制路径向上找到 .app bundle 路径
// 例如: /Applications/冰茶AI.app/Contents/MacOS/BingchaAI → /Applications/冰茶AI.app
func findAppBundlePath(exePath string) string {
	dir := exePath
	for i := 0; i < 5; i++ {
		dir = filepath.Dir(dir)
		if strings.HasSuffix(dir, ".app") {
			return dir
		}
		if dir == "/" || dir == "." {
			break
		}
	}
	return ""
}

// isNewerVersion 判断 a 是否比 b 新（简单数字版本比较）
func isNewerVersion(a, b string) bool {
	a = strings.TrimPrefix(a, "v")
	b = strings.TrimPrefix(b, "v")
	if a == "" || b == "" {
		return false
	}

	aParts := strings.Split(a, ".")
	bParts := strings.Split(b, ".")

	for i := 0; i < len(aParts) || i < len(bParts); i++ {
		var av, bv int
		if i < len(aParts) {
			fmt.Sscanf(aParts[i], "%d", &av)
		}
		if i < len(bParts) {
			fmt.Sscanf(bParts[i], "%d", &bv)
		}
		if av > bv {
			return true
		}
		if av < bv {
			return false
		}
	}
	return false
}

func mustNewRequest(method, url string) *http.Request {
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		panic(err)
	}
	req.Header.Set("User-Agent", fmt.Sprintf("BingchaAI/%s", AppVersion))
	return req
}

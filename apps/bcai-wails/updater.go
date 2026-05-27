package main

import (
	"archive/tar"
	"compress/gzip"
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
var AppVersion = "5.0.9"

const (
	UpdateCheckURL  = "https://bcai.site/updates/latest-wails.json"
	UpdateCheckFreq = 30 * time.Minute
)

// ─── Update Info ─────────────────────────────────────────────────────────

// PlatformAsset 平台特定的下载信息
type PlatformAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type UpdateInfo struct {
	Version   string `json:"version"`
	URL       string `json:"url"`       // 下载地址（默认/Windows）
	SHA256    string `json:"sha256"`    // 校验和
	Size      int64  `json:"size"`      // 文件大小
	Changelog string `json:"changelog"` // 更新日志
	MinVer    string `json:"minVersion"` // 最低支持版本（低于此版本强制更新）

	// 平台特定下载信息 (OS -> ARCH -> asset)
	MacOS map[string]PlatformAsset `json:"macOS"`
	Linux map[string]PlatformAsset `json:"linux"`
}

type UpdateStatus struct {
	Status     string  `json:"status"`     // checking, available, downloading, ready, up-to-date, error
	Version    string  `json:"version"`
	Current    string  `json:"current"`
	Changelog  string  `json:"changelog"`
	Percent    float64 `json:"percent"`
	Error      string  `json:"error"`
	CanSkip    bool    `json:"canSkip"`    // 是否可以跳过
}

// ─── Updater ─────────────────────────────────────────────────────────────

type Updater struct {
	mu         sync.RWMutex
	status     UpdateStatus
	info       *UpdateInfo
	stopCh     chan struct{}
	running    bool
	exePath    string // 当前 exe 路径
	httpClient *http.Client
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
			httpClient: &http.Client{
				Timeout: 30 * time.Second,
			},
		}
	})
	return updaterInstance
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
	Log("[updater] Checking for updates...")

	req, err := http.NewRequest("GET", UpdateCheckURL, nil)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Error: err.Error()})
		return nil
	}
	req.Header.Set("User-Agent", fmt.Sprintf("BingchaAI/%s (%s/%s)", AppVersion, runtime.GOOS, runtime.GOARCH))

	resp, err := u.httpClient.Do(req)
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

	// 根据当前操作系统和架构选择对应的下载地址
	resolvePlatformAsset(&info)

	if !isNewerVersion(info.Version, AppVersion) {
		Log("[updater] Already up to date (v%s)", AppVersion)
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

	downloadURL := info.URL
	if downloadURL == "" {
		return fmt.Errorf("更新下载地址为空")
	}

	Log("[updater] Downloading v%s from %s", info.Version, downloadURL)
	u.setStatus(UpdateStatus{
		Status:  "downloading",
		Version: info.Version,
		Percent: 0,
	})

	// 下载到临时文件
	tmpDir := filepath.Dir(u.exePath)
	tmpFile := filepath.Join(tmpDir, fmt.Sprintf(".update-%s.tmp", info.Version))
	defer func() {
		if _, err := os.Stat(tmpFile); err == nil {
			// 如果更新失败，清理临时文件
			u.mu.RLock()
			status := u.status.Status
			u.mu.RUnlock()
			if status == "error" {
				_ = os.Remove(tmpFile)
			}
		}
	}()

	resp, err := u.httpClient.Do(mustNewRequest("GET", downloadURL))
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
	if totalSize <= 0 && info.Size > 0 {
		totalSize = info.Size
	}

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

	// 从下载文件中提取二进制（macOS .dmg / Linux .tar.gz 需要解包）
	newBinary, err := extractBinary(tmpFile, downloadURL, info.Version)
	if err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("解包失败: %v", err)})
		return err
	}
	// 如果提取出了新文件，清理原始下载文件
	if newBinary != tmpFile {
		_ = os.Remove(tmpFile)
	}

	// 替换当前 exe
	oldExe := u.exePath + ".old"
	_ = os.Remove(oldExe) // 清理上次残留的 .old

	// 1. 把当前 exe 重命名为 .old
	if err := os.Rename(u.exePath, oldExe); err != nil {
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("替换失败(rename): %v", err)})
		return fmt.Errorf("rename current exe: %w", err)
	}

	// 2. 把提取出的新二进制移到 exe 位置
	if err := os.Rename(newBinary, u.exePath); err != nil {
		// 回滚
		_ = os.Rename(oldExe, u.exePath)
		u.setStatus(UpdateStatus{Status: "error", Version: info.Version, Error: fmt.Sprintf("替换失败(move): %v", err)})
		return fmt.Errorf("move new exe: %w", err)
	}

	// 确保新二进制有执行权限 (macOS/Linux)
	if runtime.GOOS != "windows" {
		_ = os.Chmod(u.exePath, 0755)
	}

	Log("[updater] Update applied: v%s → v%s", AppVersion, info.Version)
	u.setStatus(UpdateStatus{
		Status:  "ready",
		Version: info.Version,
		Changelog: info.Changelog,
	})

	return nil
}

// RestartApp 重启应用以应用更新
func (u *Updater) RestartApp() error {
	Log("[updater] Restarting application...")

	// 保存统计数据
	GetUsageStats().Save()

	cmd := exec.Command(u.exePath)
	cmd.Dir = filepath.Dir(u.exePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("restart failed: %w", err)
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

// ─── Platform-specific Extraction ────────────────────────────────────────

// extractBinary 从下载文件中提取可执行二进制
// Windows (.exe): 直接返回，无需解包
// Linux (.tar.gz): 解压并找到可执行文件
// macOS (.dmg): 挂载 DMG，拷贝 .app 内的二进制，卸载
func extractBinary(downloadedFile, downloadURL, version string) (string, error) {
	lurl := strings.ToLower(downloadURL)
	dir := filepath.Dir(downloadedFile)

	switch {
	case strings.HasSuffix(lurl, ".tar.gz") || strings.HasSuffix(lurl, ".tgz"):
		return extractFromTarGz(downloadedFile, dir, version)
	case strings.HasSuffix(lurl, ".dmg"):
		return extractFromDMG(downloadedFile, dir, version)
	default:
		// Windows .exe 或其他：直接使用下载文件
		return downloadedFile, nil
	}
}

// extractFromTarGz 从 .tar.gz 中提取第一个可执行文件
func extractFromTarGz(archive, destDir, version string) (string, error) {
	Log("[updater] Extracting binary from tar.gz: %s", archive)

	f, err := os.Open(archive)
	if err != nil {
		return "", fmt.Errorf("open archive: %w", err)
	}
	defer f.Close()

	gr, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("gzip reader: %w", err)
	}
	defer gr.Close()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("tar read: %w", err)
		}

		// 跳过目录，只找普通文件
		if hdr.Typeflag != tar.TypeReg {
			continue
		}

		// tar 中应该只有一个二进制文件（CI 构建方式决定的）
		// 提取第一个普通文件作为新二进制
		outPath := filepath.Join(destDir, fmt.Sprintf(".update-binary-%s", version))
		out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
		if err != nil {
			return "", fmt.Errorf("create output: %w", err)
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			_ = os.Remove(outPath)
			return "", fmt.Errorf("extract file: %w", err)
		}
		out.Close()
		Log("[updater] Extracted binary from tar.gz: %s (%s)", hdr.Name, outPath)
		return outPath, nil
	}

	return "", fmt.Errorf("tar.gz 中未找到可执行文件")
}

// extractFromDMG 挂载 macOS DMG，从 .app bundle 中拷贝二进制
func extractFromDMG(dmgFile, destDir, version string) (string, error) {
	Log("[updater] Extracting binary from DMG: %s", dmgFile)

	mountPoint := filepath.Join(destDir, fmt.Sprintf(".update-dmg-mount-%s", version))
	_ = os.MkdirAll(mountPoint, 0755)
	defer func() {
		// 卸载并清理挂载点
		_ = exec.Command("hdiutil", "detach", mountPoint, "-quiet", "-force").Run()
		_ = os.RemoveAll(mountPoint)
	}()

	// 挂载 DMG
	cmd := exec.Command("hdiutil", "attach", dmgFile, "-mountpoint", mountPoint, "-nobrowse", "-quiet")
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("mount DMG failed: %w\noutput: %s", err, string(out))
	}

	// 在挂载点中找 .app bundle
	entries, err := os.ReadDir(mountPoint)
	if err != nil {
		return "", fmt.Errorf("read mount point: %w", err)
	}

	var appPath string
	for _, e := range entries {
		if e.IsDir() && strings.HasSuffix(e.Name(), ".app") {
			appPath = filepath.Join(mountPoint, e.Name())
			break
		}
	}
	if appPath == "" {
		return "", fmt.Errorf("DMG 中未找到 .app bundle")
	}

	// .app/Contents/MacOS/ 下的二进制
	macOSDir := filepath.Join(appPath, "Contents", "MacOS")
	binEntries, err := os.ReadDir(macOSDir)
	if err != nil {
		return "", fmt.Errorf("read MacOS dir: %w", err)
	}

	var srcBin string
	for _, e := range binEntries {
		if !e.IsDir() {
			srcBin = filepath.Join(macOSDir, e.Name())
			break
		}
	}
	if srcBin == "" {
		return "", fmt.Errorf(".app/Contents/MacOS/ 中未找到二进制文件")
	}

	// 拷贝到目标目录
	outPath := filepath.Join(destDir, fmt.Sprintf(".update-binary-%s", version))
	src, err := os.Open(srcBin)
	if err != nil {
		return "", fmt.Errorf("open binary: %w", err)
	}
	defer src.Close()

	dst, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return "", fmt.Errorf("create output: %w", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(outPath)
		return "", fmt.Errorf("copy binary: %w", err)
	}
	dst.Close()

	Log("[updater] Extracted binary from DMG: %s → %s", srcBin, outPath)
	return outPath, nil
}

// ─── Platform Resolution ─────────────────────────────────────────────────

// resolvePlatformAsset 根据 runtime.GOOS / runtime.GOARCH 覆盖顶层下载字段
func resolvePlatformAsset(info *UpdateInfo) {
	var assets map[string]PlatformAsset

	switch runtime.GOOS {
	case "darwin":
		assets = info.MacOS
	case "linux":
		assets = info.Linux
	default:
		// Windows 或其他：使用顶层字段，无需覆盖
		return
	}

	if assets == nil {
		Log("[updater] No platform-specific asset for %s, using default URL", runtime.GOOS)
		return
	}

	// 优先匹配精确架构，其次尝试通用 key
	arch := runtime.GOARCH
	asset, ok := assets[arch]
	if !ok {
		// 尝试 "universal" key（macOS universal binary 场景）
		asset, ok = assets["universal"]
	}
	if !ok {
		Log("[updater] No asset for %s/%s, using default URL", runtime.GOOS, arch)
		return
	}

	Log("[updater] Resolved platform asset: %s/%s → %s", runtime.GOOS, arch, asset.URL)
	if asset.URL != "" {
		info.URL = asset.URL
	}
	if asset.SHA256 != "" {
		info.SHA256 = asset.SHA256
	}
	if asset.Size > 0 {
		info.Size = asset.Size
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// HostProtectionConfig 是非沙箱 Claude 接管前的宿主防护配置。Targets 使用接管调度键:
// claude=Claude Code, claude_desktop=Claude Desktop。
type HostProtectionConfig struct {
	TimezoneStrategy string   `json:"timezoneStrategy"` // follow | fixed | unchanged
	FixedTimezone    string   `json:"fixedTimezone"`
	BlockWebRTC      bool     `json:"blockWebRTC"`
	BlockGeolocation bool     `json:"blockGeolocation"`
	Targets          []string `json:"targets"`
}

// HostProtectionStatus 是前端唯一状态源。Mode: configure | active | residue | restored。
type HostProtectionStatus struct {
	Mode                  string   `json:"mode"`
	Platform              string   `json:"platform"`
	RequiresAuthorization bool     `json:"requiresAuthorization"`
	OriginalTimezone      string   `json:"originalTimezone"`
	ExitTimezone          string   `json:"exitTimezone"`
	AppliedTimezone       string   `json:"appliedTimezone"`
	TimezoneStrategy      string   `json:"timezoneStrategy"`
	BlockWebRTC           bool     `json:"blockWebRTC"`
	BlockGeolocation      bool     `json:"blockGeolocation"`
	DNSCleared            bool     `json:"dnsCleared"`
	Targets               []string `json:"targets"`
	LastError             string   `json:"lastError,omitempty"`
}

type hostProtectionSnapshot struct {
	Version                   int                  `json:"version"`
	State                     string               `json:"state"` // applying | active | restoring
	OwnerPID                  int                  `json:"ownerPid"`
	CreatedAt                 string               `json:"createdAt"`
	OriginalSystemTimezone    string               `json:"originalSystemTimezone"`
	OriginalDisplayTimezone   string               `json:"originalDisplayTimezone"`
	ExitTimezone              string               `json:"exitTimezone"`
	AppliedSystemTimezone     string               `json:"appliedSystemTimezone"`
	AppliedTimezone           string               `json:"appliedTimezone"`
	TimezoneStrategy          string               `json:"timezoneStrategy"`
	TimezoneChanged           bool                 `json:"timezoneChanged"`
	BlockWebRTC               bool                 `json:"blockWebRTC"`
	BlockGeolocation          bool                 `json:"blockGeolocation"`
	DNSCleared                bool                 `json:"dnsCleared"`
	Targets                   []string             `json:"targets"`
	LastError                 string               `json:"lastError,omitempty"`
	BrowserPreferencesPath    string               `json:"browserPreferencesPath,omitempty"`
	BrowserPreferencesHadFile bool                 `json:"browserPreferencesHadFile"`
	BrowserPreferencesPerm    uint32               `json:"browserPreferencesPerm,omitempty"`
	BrowserPreferencesChanged bool                 `json:"browserPreferencesChanged"`
	WebRTCPreference          hostPreferenceBackup `json:"webRTCPreference"`
	GeolocationPreference     hostPreferenceBackup `json:"geolocationPreference"`
}

const hostProtectionSnapshotVersion = 1

var hostProtectionMu sync.Mutex

func hostProtectionSnapshotPath() string {
	return filepath.Join(getAppDataDir(), "host-protection.json")
}

func readHostProtectionSnapshot() (*hostProtectionSnapshot, error) {
	data, err := os.ReadFile(hostProtectionSnapshotPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap hostProtectionSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("解析宿主防护快照失败: %w", err)
	}
	if snap.Version != hostProtectionSnapshotVersion {
		return nil, fmt.Errorf("不支持的宿主防护快照版本: %d", snap.Version)
	}
	return &snap, nil
}

func writeHostProtectionSnapshot(snap *hostProtectionSnapshot) error {
	if err := os.MkdirAll(getAppDataDir(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(hostProtectionSnapshotPath(), data, 0o600)
}

func removeHostProtectionSnapshot() error {
	err := os.Remove(hostProtectionSnapshotPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func normalizeHostTargets(targets []string) ([]string, error) {
	seen := map[string]bool{}
	for _, raw := range targets {
		t := strings.ToLower(strings.TrimSpace(raw))
		if t == "claude_code" {
			t = "claude"
		}
		if t != "claude" && t != "claude_desktop" {
			return nil, fmt.Errorf("不支持的宿主防护目标: %s", raw)
		}
		seen[t] = true
	}
	if len(seen) == 0 {
		return nil, errors.New("至少选择一个 Claude 接管目标")
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return out, nil
}

var fixedHostProtectionTimezones = map[string]bool{
	"Asia/Singapore": true, "Asia/Kuala_Lumpur": true, "Asia/Kuching": true,
	"Asia/Taipei": true, "Asia/Manila": true, "Asia/Brunei": true,
	"Asia/Makassar": true, "Asia/Ulaanbaatar": true, "Asia/Irkutsk": true,
	"Australia/Perth": true,
}

func validateHostProtectionConfig(cfg HostProtectionConfig) (HostProtectionConfig, error) {
	cfg.TimezoneStrategy = strings.ToLower(strings.TrimSpace(cfg.TimezoneStrategy))
	// 时区保留用户策略；其余宿主防护是接管基线，不对外暴露关闭入口。
	cfg.BlockWebRTC = true
	cfg.BlockGeolocation = true
	if cfg.TimezoneStrategy == "" {
		cfg.TimezoneStrategy = "follow"
	}
	if cfg.TimezoneStrategy != "follow" && cfg.TimezoneStrategy != "fixed" && cfg.TimezoneStrategy != "unchanged" {
		return cfg, fmt.Errorf("无效的时区策略: %s", cfg.TimezoneStrategy)
	}
	var err error
	cfg.Targets, err = normalizeHostTargets(cfg.Targets)
	if err != nil {
		return cfg, err
	}
	if cfg.TimezoneStrategy == "fixed" {
		cfg.FixedTimezone = strings.TrimSpace(cfg.FixedTimezone)
		if !fixedHostProtectionTimezones[cfg.FixedTimezone] {
			return cfg, fmt.Errorf("固定时区不在安全列表中: %s", cfg.FixedTimezone)
		}
	}
	return cfg, nil
}

func containsHostTarget(targets []string, wanted string) bool {
	for _, target := range targets {
		if target == wanted {
			return true
		}
	}
	return false
}

// probeHostProtectionTimezone 走 Anthropic 当前静态出口探测 IANA 时区。正式应用时若包含
// Desktop，优先复用白号会话的精确出口；否则使用 Anthropic API 账号出口。
func probeHostProtectionTimezone(targets []string, prepareDesktopLease bool) (string, error) {
	if appActionsSuppressed() {
		return "Asia/Singapore", nil
	}
	proxyURL := ""
	if prepareDesktopLease && containsHostTarget(targets, "claude_desktop") {
		GetMitmManager().LeaseWhiteSession()
		proxyURL = GetClaudeSessionLeaser().CurrentProxyURL()
	}
	if strings.TrimSpace(proxyURL) == "" {
		eg, err := egressInfoForTakeover("anthropic", LoadConfig())
		if err != nil {
			return "", fmt.Errorf("获取 Anthropic 出口失败: %w", err)
		}
		proxyURL = eg.ProxyURL
	}
	if strings.TrimSpace(proxyURL) == "" {
		return "", errors.New("Anthropic 出口未提供代理，无法安全解析时区")
	}
	tz, err := probeExitTimezone(proxyURL)
	if err != nil {
		return "", fmt.Errorf("解析出口时区失败: %w", err)
	}
	if !ianaTZPattern.MatchString(tz) {
		return "", fmt.Errorf("出口返回了无效时区: %s", tz)
	}
	return tz, nil
}

func hostStatusFromSnapshot(snap *hostProtectionSnapshot, mode string) HostProtectionStatus {
	return HostProtectionStatus{
		Mode:                  mode,
		Platform:              hostProtectionPlatform(),
		RequiresAuthorization: hostProtectionRequiresAuthorization(snap.TimezoneChanged),
		OriginalTimezone:      snap.OriginalDisplayTimezone,
		ExitTimezone:          snap.ExitTimezone,
		AppliedTimezone:       snap.AppliedTimezone,
		TimezoneStrategy:      snap.TimezoneStrategy,
		BlockWebRTC:           snap.BlockWebRTC,
		BlockGeolocation:      snap.BlockGeolocation,
		DNSCleared:            snap.DNSCleared,
		Targets:               append([]string(nil), snap.Targets...),
		LastError:             snap.LastError,
	}
}

func getHostProtectionStatusLocked() (HostProtectionStatus, error) {
	snap, err := readHostProtectionSnapshot()
	if err != nil {
		return HostProtectionStatus{Mode: "residue", Platform: hostProtectionPlatform(), LastError: err.Error()}, nil
	}
	if snap != nil {
		mode := "active"
		if snap.OwnerPID != os.Getpid() || snap.State != "active" {
			mode = "residue"
		}
		return hostStatusFromSnapshot(snap, mode), nil
	}
	_, display, readErr := hostProtectionReadTimezone()
	if readErr != nil {
		Log("[host-protection] 读取当前时区失败: %v", readErr)
	}
	return HostProtectionStatus{
		Mode:                  "configure",
		Platform:              hostProtectionPlatform(),
		RequiresAuthorization: runtime.GOOS == "darwin",
		OriginalTimezone:      display,
		TimezoneStrategy:      "follow",
		BlockWebRTC:           true,
		BlockGeolocation:      true,
	}, nil
}

// GetHostProtectionStatus 返回当前真实状态；旧 PID 的快照一律视为异常残留。
func (a *App) GetHostProtectionStatus() (HostProtectionStatus, error) {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	return getHostProtectionStatusLocked()
}

// ProbeHostProtectionStatus 只探出口与当前时区，不改机器，供接管前配置面板展示。
func (a *App) ProbeHostProtectionStatus(targets []string) (HostProtectionStatus, error) {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	if snap, err := readHostProtectionSnapshot(); err != nil {
		return HostProtectionStatus{}, err
	} else if snap != nil {
		mode := "active"
		if snap.OwnerPID != os.Getpid() || snap.State != "active" {
			mode = "residue"
		}
		return hostStatusFromSnapshot(snap, mode), nil
	}
	normalized, err := normalizeHostTargets(targets)
	if err != nil {
		return HostProtectionStatus{}, err
	}
	_, original, err := hostProtectionReadTimezone()
	if err != nil {
		return HostProtectionStatus{}, fmt.Errorf("读取本机时区失败: %w", err)
	}
	exitTZ, err := probeHostProtectionTimezone(normalized, false)
	if err != nil {
		return HostProtectionStatus{}, err
	}
	return HostProtectionStatus{
		Mode:                  "configure",
		Platform:              hostProtectionPlatform(),
		RequiresAuthorization: runtime.GOOS == "darwin",
		OriginalTimezone:      original,
		ExitTimezone:          exitTZ,
		TimezoneStrategy:      "follow",
		BlockWebRTC:           true,
		BlockGeolocation:      true,
		Targets:               normalized,
	}, nil
}

// ApplyHostProtection 先持久化原值再触碰系统。任何中途崩溃都会留下可恢复快照。
func (a *App) ApplyHostProtection(input HostProtectionConfig) (HostProtectionStatus, error) {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()

	if existing, err := readHostProtectionSnapshot(); err != nil {
		return HostProtectionStatus{}, err
	} else if existing != nil {
		mode := "active"
		if existing.OwnerPID != os.Getpid() || existing.State != "active" {
			mode = "residue"
		}
		return hostStatusFromSnapshot(existing, mode), errors.New("检测到未还原的宿主防护，请先恢复后再接管")
	}

	cfg, err := validateHostProtectionConfig(input)
	if err != nil {
		return HostProtectionStatus{}, err
	}
	originalSystem, originalDisplay, err := hostProtectionReadTimezone()
	if err != nil {
		return HostProtectionStatus{}, fmt.Errorf("备份本机时区失败: %w", err)
	}

	exitTZ := ""
	if cfg.TimezoneStrategy == "follow" {
		exitTZ, err = probeHostProtectionTimezone(cfg.Targets, true)
		if err != nil {
			return HostProtectionStatus{}, err
		}
	} else {
		// 固定/不改不应因地理探测失败而中断；成功时仍记录，供界面做一致性提示。
		exitTZ, _ = probeHostProtectionTimezone(cfg.Targets, cfg.TimezoneStrategy == "fixed")
	}
	appliedTZ := originalDisplay
	if cfg.TimezoneStrategy == "follow" {
		appliedTZ = exitTZ
	} else if cfg.TimezoneStrategy == "fixed" {
		appliedTZ = cfg.FixedTimezone
	}
	timezoneChanged := cfg.TimezoneStrategy != "unchanged" && strings.TrimSpace(appliedTZ) != ""

	snap := &hostProtectionSnapshot{
		Version:                 hostProtectionSnapshotVersion,
		State:                   "applying",
		OwnerPID:                os.Getpid(),
		CreatedAt:               time.Now().UTC().Format(time.RFC3339),
		OriginalSystemTimezone:  originalSystem,
		OriginalDisplayTimezone: originalDisplay,
		ExitTimezone:            exitTZ,
		AppliedTimezone:         appliedTZ,
		TimezoneStrategy:        cfg.TimezoneStrategy,
		TimezoneChanged:         timezoneChanged,
		BlockWebRTC:             cfg.BlockWebRTC,
		BlockGeolocation:        cfg.BlockGeolocation,
		Targets:                 cfg.Targets,
	}
	if err := captureHostBrowserPreferences(snap); err != nil {
		return HostProtectionStatus{}, fmt.Errorf("备份 Claude 浏览器防护设置失败: %w", err)
	}
	if err := writeHostProtectionSnapshot(snap); err != nil {
		return HostProtectionStatus{}, fmt.Errorf("保存宿主防护备份失败: %w", err)
	}

	var applyErr error
	if snap.BrowserPreferencesChanged {
		hostProtectionStopDesktopForPreferences()
		applyErr = applyHostBrowserPreferences(snap)
	}
	result := hostProtectionApplyResult{}
	if applyErr == nil {
		result, applyErr = hostProtectionApply(appliedTZ, timezoneChanged, true)
	}
	if applyErr != nil {
		snap.LastError = applyErr.Error()
		_ = writeHostProtectionSnapshot(snap)
		browserRestoreErr := restoreHostBrowserPreferences(snap)
		if restoreErr := hostProtectionRestore(originalSystem, timezoneChanged); restoreErr == nil && browserRestoreErr == nil {
			_ = removeHostProtectionSnapshot()
		} else {
			snap.LastError = fmt.Sprintf("应用失败: %v；自动还原失败: system=%v browser=%v", applyErr, restoreErr, browserRestoreErr)
			_ = writeHostProtectionSnapshot(snap)
		}
		return hostStatusFromSnapshot(snap, "residue"), fmt.Errorf("应用宿主防护失败: %w", applyErr)
	}
	snap.AppliedSystemTimezone = result.AppliedSystemTimezone
	snap.DNSCleared = result.DNSCleared
	snap.State = "active"
	snap.LastError = ""
	if err := writeHostProtectionSnapshot(snap); err != nil {
		_ = hostProtectionRestore(originalSystem, timezoneChanged)
		return hostStatusFromSnapshot(snap, "residue"), fmt.Errorf("确认宿主防护状态失败: %w", err)
	}
	Log("[host-protection] 已生效: timezone=%s strategy=%s webrtc=%v geolocation=%v dns=%v targets=%v",
		appliedTZ, cfg.TimezoneStrategy, cfg.BlockWebRTC, cfg.BlockGeolocation, snap.DNSCleared, cfg.Targets)
	return hostStatusFromSnapshot(snap, "active"), nil
}

func restoreHostProtectionLocked(snap *hostProtectionSnapshot) (HostProtectionStatus, error) {
	snap.State = "restoring"
	snap.OwnerPID = os.Getpid()
	_ = writeHostProtectionSnapshot(snap)
	if snap.BrowserPreferencesChanged {
		hostProtectionStopDesktopForPreferences()
	}
	browserErr := restoreHostBrowserPreferences(snap)
	systemErr := hostProtectionRestore(snap.OriginalSystemTimezone, snap.TimezoneChanged)
	if browserErr != nil || systemErr != nil {
		snap.LastError = fmt.Sprintf("浏览器设置还原=%v；系统时区还原=%v", browserErr, systemErr)
		_ = writeHostProtectionSnapshot(snap)
		return hostStatusFromSnapshot(snap, "residue"), fmt.Errorf("还原宿主环境失败: %s", snap.LastError)
	}
	if err := removeHostProtectionSnapshot(); err != nil {
		snap.LastError = err.Error()
		return hostStatusFromSnapshot(snap, "residue"), fmt.Errorf("清理宿主防护备份失败: %w", err)
	}
	Log("[host-protection] 已完整还原: timezone=%s", snap.OriginalDisplayTimezone)
	status := hostStatusFromSnapshot(snap, "restored")
	status.AppliedTimezone = snap.OriginalDisplayTimezone
	status.BlockWebRTC = false
	status.BlockGeolocation = false
	return status, nil
}

// RestoreHostProtection 精确恢复快照中的原系统时区。成功后才删除备份；失败则保留为 residue。
func (a *App) RestoreHostProtection() (HostProtectionStatus, error) {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	snap, err := readHostProtectionSnapshot()
	if err != nil {
		return HostProtectionStatus{}, err
	}
	if snap == nil {
		status, err := getHostProtectionStatusLocked()
		status.Mode = "restored"
		return status, err
	}
	return restoreHostProtectionLocked(snap)
}

// ReleaseHostProtectionTarget 在某个 Claude 客户端单独停止后更新防护目标；最后一个目标
// 停止时自动还原宿主。这样新面板不丢掉旧版「Code / Desktop 分别停止」的能力。
func (a *App) ReleaseHostProtectionTarget(rawTarget string) (HostProtectionStatus, error) {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	targets, err := normalizeHostTargets([]string{rawTarget})
	if err != nil {
		return HostProtectionStatus{}, err
	}
	target := targets[0]
	snap, err := readHostProtectionSnapshot()
	if err != nil {
		return HostProtectionStatus{}, err
	}
	if snap == nil {
		return getHostProtectionStatusLocked()
	}
	remaining := make([]string, 0, len(snap.Targets))
	for _, current := range snap.Targets {
		if current != target {
			remaining = append(remaining, current)
		}
	}
	if len(remaining) == len(snap.Targets) {
		return hostStatusFromSnapshot(snap, "active"), nil
	}
	if len(remaining) == 0 {
		return restoreHostProtectionLocked(snap)
	}
	if target == "claude_desktop" && snap.BrowserPreferencesChanged {
		hostProtectionStopDesktopForPreferences()
		if err := restoreHostBrowserPreferences(snap); err != nil {
			snap.LastError = err.Error()
			_ = writeHostProtectionSnapshot(snap)
			return hostStatusFromSnapshot(snap, "residue"), err
		}
		snap.BrowserPreferencesChanged = false
		snap.BrowserPreferencesPath = ""
	}
	snap.Targets = remaining
	snap.OwnerPID = os.Getpid()
	snap.State = "active"
	if err := writeHostProtectionSnapshot(snap); err != nil {
		return hostStatusFromSnapshot(snap, "residue"), err
	}
	Log("[host-protection] 已停止目标 %s，剩余防护目标=%v", target, remaining)
	return hostStatusFromSnapshot(snap, "active"), nil
}

// activeHostProtectionSnapshot 只返回本进程成功应用的快照。旧 PID 残留绝不继续注入标志。
func activeHostProtectionSnapshot() *hostProtectionSnapshot {
	hostProtectionMu.Lock()
	defer hostProtectionMu.Unlock()
	snap, err := readHostProtectionSnapshot()
	if err != nil || snap == nil || snap.OwnerPID != os.Getpid() || snap.State != "active" {
		return nil
	}
	return snap
}

func hostProtectionProcessTimezone() string {
	if snap := activeHostProtectionSnapshot(); snap != nil && snap.TimezoneStrategy != "unchanged" {
		return snap.AppliedTimezone
	}
	return ""
}

func hostProtectionChromiumArgs() []string {
	snap := activeHostProtectionSnapshot()
	if snap == nil {
		return nil
	}
	var args []string
	if snap.BlockWebRTC {
		args = append(args, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
	}
	if snap.BlockGeolocation {
		// Chromium 当前已移除旧 --disable-geolocation；官方权限组件提供此开关，
		// 与已备份的 geolocation=BLOCK profile 设置组成双保险。
		args = append(args, "--deny-permission-prompts")
	}
	return args
}

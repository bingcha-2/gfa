package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const diagnosticLogMaxBytes = 512 * 1024

var (
	diagnosticExportMu            sync.Mutex
	diagnosticWindowsAbsolutePath = regexp.MustCompile(`(?i)[A-Z]:[\\/][^\s,;"'()\[\]{}]+`)
	diagnosticUNCAbsolutePath     = regexp.MustCompile(`\\\\[^\s,;"'()\[\]{}]+`)
	diagnosticUnixAbsolutePath    = regexp.MustCompile(`(?:^|[\s=:(\["'])(/[^\s,;"'()\[\]{}]+)`)
	diagnosticRedactors           = []struct {
		re          *regexp.Regexp
		replacement string
	}{
		{regexp.MustCompile(`(?i)(["']?authorization["']?\s*[:=]\s*)[^\r\n]+`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)(["']?(?:set-cookie|cookie)["']?\s*[:=]\s*)[^\r\n]+`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)((?:access[_-]?token|refresh[_-]?token|id[_-]?token|user[_-]?token|token|api[_-]?key|apikey|key|password|passwd|secret|account[_-]?card|card|device[_-]?id|user[_-]?id|subscription[_-]?id|account[_-]?id|lease[_-]?id|session[_-]?id|authorization[_-]?code|oauth[_-]?code)["']?\s*[:=]\s*["']?)[^\s,;&"'}\]]+`), `${1}[REDACTED]`},
		{regexp.MustCompile(`(?i)\b((?:route)?acct|account)\s*(?:#|[:=])\s*[A-Za-z0-9._-]+`), `${1}=[REDACTED]`},
		{regexp.MustCompile(`(?i)(https?://)[^/\s:@]+:[^@\s/]+@`), `${1}[REDACTED]@`},
		{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b`), `[REDACTED_JWT]`},
		{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}\b`), `[REDACTED_KEY]`},
		{regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`), `[REDACTED_ID]`},
		{regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`), `[REDACTED_EMAIL]`},
		{regexp.MustCompile(`(?i)([A-Z]:\\Users\\)[^\\\s]+`), `${1}[USER]`},
		{regexp.MustCompile(`(/(?:Users|home)/)[^/\s]+`), `${1}[USER]`},
	}
)

func redactDiagnosticAbsolutePaths(value string) string {
	value = diagnosticWindowsAbsolutePath.ReplaceAllString(value, `[REDACTED_PATH]`)
	value = diagnosticUNCAbsolutePath.ReplaceAllString(value, `[REDACTED_PATH]`)
	return diagnosticUnixAbsolutePath.ReplaceAllStringFunc(value, func(match string) string {
		prefix := ""
		if !strings.HasPrefix(match, "/") {
			prefix = match[:1]
		}
		return prefix + "[REDACTED_PATH]"
	})
}

type diagnosticApplicationInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func keepDiagnosticTail(data []byte, maxBytes int) []byte {
	if maxBytes <= 0 {
		return nil
	}
	if len(data) <= maxBytes {
		return data
	}
	data = data[len(data)-maxBytes:]
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[1:]
	}
	return data
}

type diagnosticSystemInfo struct {
	OS        string `json:"os"`
	OSVersion string `json:"osVersion"`
	Arch      string `json:"arch"`
	GoRuntime string `json:"goRuntime"`
}

type diagnosticLogInfo struct {
	Included  bool   `json:"included"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
	ReadError string `json:"readError,omitempty"`
}

type diagnosticReport struct {
	SchemaVersion int                       `json:"schemaVersion"`
	GeneratedAt   string                    `json:"generatedAt"`
	Application   diagnosticApplicationInfo `json:"application"`
	System        diagnosticSystemInfo      `json:"system"`
	Proxy         HTTPProxyStatus           `json:"proxy"`
	Log           diagnosticLogInfo         `json:"log"`
}

type diagnosticSafeConfig struct {
	ProxyPort               int    `json:"proxyPort"`
	LoggedIn                bool   `json:"loggedIn"`
	SubscriptionCount       int    `json:"subscriptionCount"`
	IDEPathConfigured       bool   `json:"idePathConfigured"`
	HubPathConfigured       bool   `json:"hubPathConfigured"`
	CodexAppPathConfigured  bool   `json:"codexAppPathConfigured"`
	ClaudeDesktopConfigured bool   `json:"claudeDesktopConfigured"`
	CodexMode               string `json:"codexMode"`
	CodexRelayConfigured    bool   `json:"codexRelayConfigured"`
	CodexRelayProtocol      string `json:"codexRelayProtocol"`
	CodexModelMappingCount  int    `json:"codexModelMappingCount"`
	CodexFastMode           bool   `json:"codexFastMode"`
}

func redactDiagnosticText(value string) string {
	redacted := value
	for _, rule := range diagnosticRedactors {
		redacted = rule.re.ReplaceAllString(redacted, rule.replacement)
	}
	return redactDiagnosticAbsolutePaths(redacted)
}

func makeDiagnosticSafeConfig(cfg Config) diagnosticSafeConfig {
	mode := strings.ToLower(strings.TrimSpace(cfg.CodexMode))
	if mode == "" {
		mode = "rental"
	}
	if mode != "rental" && mode != "relay" {
		mode = "unknown"
	}

	protocol := strings.ToLower(strings.TrimSpace(cfg.CodexRelayProtocol))
	if protocol == "" {
		protocol = "responses"
	}
	if protocol != "responses" && protocol != "chat" {
		protocol = "unknown"
	}

	return diagnosticSafeConfig{
		ProxyPort:               cfg.ProxyPort,
		LoggedIn:                strings.TrimSpace(cfg.UserToken) != "",
		SubscriptionCount:       len(cfg.Subscriptions),
		IDEPathConfigured:       strings.TrimSpace(cfg.IDEPath) != "",
		HubPathConfigured:       strings.TrimSpace(cfg.HubPath) != "",
		CodexAppPathConfigured:  strings.TrimSpace(cfg.CodexAppPath) != "",
		ClaudeDesktopConfigured: strings.TrimSpace(cfg.ClaudeDesktopPath) != "",
		CodexMode:               mode,
		CodexRelayConfigured:    strings.TrimSpace(cfg.CodexRelayBase) != "" && strings.TrimSpace(cfg.CodexRelayKey) != "",
		CodexRelayProtocol:      protocol,
		CodexModelMappingCount:  len(cfg.CodexModelMap),
		CodexFastMode:           cfg.CodexFastMode,
	}
}

func makeDiagnosticReport(now time.Time, proxy HTTPProxyStatus, logBytes int, truncated bool, logErr error) diagnosticReport {
	proxy.ListenAddr = redactDiagnosticText(proxy.ListenAddr)
	proxy.LastError = redactDiagnosticText(proxy.LastError)

	logInfo := diagnosticLogInfo{
		Included:  logErr == nil,
		Bytes:     logBytes,
		Truncated: truncated,
	}
	if logErr != nil {
		logInfo.ReadError = redactDiagnosticText(logErr.Error())
	}

	return diagnosticReport{
		SchemaVersion: 1,
		GeneratedAt:   now.UTC().Format(time.RFC3339),
		Application: diagnosticApplicationInfo{
			Name:    "BingchaAI",
			Version: AppVersion,
		},
		System: diagnosticSystemInfo{
			OS:        runtime.GOOS,
			OSVersion: diagnosticOSVersion(),
			Arch:      runtime.GOARCH,
			GoRuntime: runtime.Version(),
		},
		Proxy: proxy,
		Log:   logInfo,
	}
}

func readFileTail(path string, maxBytes int) ([]byte, bool, error) {
	if maxBytes <= 0 {
		return nil, false, fmt.Errorf("invalid tail size: %d", maxBytes)
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, false, err
	}

	start := info.Size() - int64(maxBytes)
	truncated := start > 0
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, false, err
	}

	data, err := io.ReadAll(io.LimitReader(file, int64(maxBytes)))
	if err != nil {
		return nil, false, err
	}
	if truncated {
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			data = data[newline+1:]
		}
	}
	return data, truncated, nil
}

func readDesktopLogTail() ([]byte, bool, error) {
	logLock.Lock()
	defer logLock.Unlock()
	return readFileTail(filepath.Join(getAppDataDir(), "logs", "desktop.log"), diagnosticLogMaxBytes)
}

func addDiagnosticZipFile(archive *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(0o600)
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

func buildDiagnosticBundle(report diagnosticReport, cfg diagnosticSafeConfig, health diagnosticHealthReport, desktopLog []byte) ([]byte, error) {
	redactedAll := []byte(redactDiagnosticText(string(desktopLog)))
	secondaryTruncation := len(redactedAll) > diagnosticLogMaxBytes
	redactedLog := keepDiagnosticTail(redactedAll, diagnosticLogMaxBytes)
	if report.Log.ReadError != "" && len(redactedLog) == 0 {
		redactedLog = []byte("desktop.log unavailable: " + report.Log.ReadError + "\n")
	}
	report.Log.Bytes = len(redactedLog)
	report.Log.Truncated = report.Log.Truncated || secondaryTruncation
	health.LogCoverage = diagnosticLogCoverageFrom(redactedLog, report.Log.Truncated)

	reportJSON, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return nil, err
	}
	healthJSON, err := json.MarshalIndent(health, "", "  ")
	if err != nil {
		return nil, err
	}
	configJSON, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}

	files := map[string][]byte{
		"error-summary.txt": append(buildDiagnosticErrorSummary(redactedLog), '\n'),
		"health-check.json": append(healthJSON, '\n'),
		"logs/desktop.log":  redactedLog,
		"report.json":       append(reportJSON, '\n'),
		"safe-config.json":  append(configJSON, '\n'),
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)

	var bundle bytes.Buffer
	archive := zip.NewWriter(&bundle)
	for _, name := range names {
		if err := addDiagnosticZipFile(archive, name, files[name]); err != nil {
			_ = archive.Close()
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return bundle.Bytes(), nil
}

func writeDiagnosticBundle(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".bingchaai-diagnostic-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}
	return replaceDiagnosticFile(tmpPath, path)
}

// diagnosticOutputPath keeps the one-click flow one step: prefer the user's
// Desktop, and fall back to the app data directory when Desktop is unavailable.
func diagnosticOutputPath(now time.Time) string {
	home, err := os.UserHomeDir()
	if err == nil && strings.TrimSpace(home) != "" {
		desktop := filepath.Join(home, "Desktop")
		if info, statErr := os.Stat(desktop); statErr == nil && info.IsDir() {
			return filepath.Join(desktop, "BingchaAI-diagnostics-"+now.Format("20060102-150405.000")+".zip")
		}
	}
	return filepath.Join(getAppDataDir(), "diagnostics", "BingchaAI-diagnostics-"+now.Format("20060102-150405.000")+".zip")
}

func diagnosticFallbackOutputPath(now time.Time) string {
	return filepath.Join(getAppDataDir(), "diagnostics", "BingchaAI-diagnostics-"+now.Format("20060102-150405.000")+".zip")
}

// ExportDiagnosticBundle lets the user create a local-only, redacted support ZIP.
// It performs no probes, network requests, uploads, or scans of other apps.
func (a *App) ExportDiagnosticBundle() (string, error) {
	if !diagnosticExportMu.TryLock() {
		return "", fmt.Errorf("a diagnostic export is already in progress")
	}
	defer diagnosticExportMu.Unlock()

	now := time.Now()
	path := diagnosticOutputPath(now)
	collectedAt := time.Now()
	cfg := LoadConfig()
	proxy := GetHTTPProxy().GetStatus()
	logData, truncated, logErr := readDesktopLogTail()
	report := makeDiagnosticReport(collectedAt, proxy, len(logData), truncated, logErr)
	health := collectDiagnosticHealth(collectedAt, cfg, proxy, logData, truncated, logErr, getAppDataDir(), filepath.Dir(path))
	bundle, err := buildDiagnosticBundle(report, makeDiagnosticSafeConfig(cfg), health, logData)
	if err != nil {
		return "", fmt.Errorf("build diagnostic bundle: %w", err)
	}
	if err := writeDiagnosticBundle(path, bundle); err != nil {
		// Desktop can exist but still be read-only (for example, a managed
		// macOS folder). Retry in the app data directory before surfacing the
		// error so one click still produces a report when possible.
		fallback := diagnosticFallbackOutputPath(now)
		if filepath.Clean(fallback) != filepath.Clean(path) {
			if fallbackErr := writeDiagnosticBundle(fallback, bundle); fallbackErr == nil {
				return fallback, nil
			}
		}
		if errors.Is(err, fs.ErrPermission) {
			return "", fmt.Errorf("所选目录没有写入权限，请改存到下载或桌面目录: %w", err)
		}
		return "", fmt.Errorf("保存诊断包失败: %w", err)
	}
	return path, nil
}

func normalizeDiagnosticPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	if !strings.EqualFold(filepath.Ext(path), ".zip") {
		path += ".zip"
	}
	return filepath.Abs(path)
}

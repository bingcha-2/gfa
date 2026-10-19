package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type diagnosticHealthCheck struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Summary   string `json:"summary"`
	ErrorKind string `json:"errorKind,omitempty"`
}

type diagnosticLogCoverage struct {
	FirstAt   string `json:"firstAt,omitempty"`
	LastAt    string `json:"lastAt,omitempty"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
	LineCount int    `json:"lineCount"`
}

type diagnosticHealthReport struct {
	SchemaVersion int                     `json:"schemaVersion"`
	GeneratedAt   string                  `json:"generatedAt"`
	OverallStatus string                  `json:"overallStatus"`
	LogCoverage   diagnosticLogCoverage   `json:"logCoverage"`
	Checks        []diagnosticHealthCheck `json:"checks"`
}

func diagnosticImageChecks(cfg Config, proxy HTTPProxyStatus, logData []byte) []diagnosticHealthCheck {
	checks := make([]diagnosticHealthCheck, 0, 2)
	provider, hadConfig, configErr := loadCodexConfig()
	if !hadConfig {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_capability", Status: "pass", Summary: "Codex integration is not enabled; image capability check was skipped"})
	} else if configErr != nil {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_capability", Status: "warn", Summary: "Codex configuration could not be parsed; image capability injection could not be verified", ErrorKind: "invalid_config"})
	} else if modelProvider, _ := provider[codexModelProvider].(string); modelProvider == codexProviderID {
		if proxy.ListenPort > 0 && IsCodexInjected(proxy.ListenPort) {
			checks = append(checks, diagnosticHealthCheck{ID: "codex.image_capability", Status: "pass", Summary: "Codex image capability injection is configured"})
		} else {
			checks = append(checks, diagnosticHealthCheck{ID: "codex.image_capability", Status: "warn", Summary: "Codex uses Bingcha integration, but image capability injection is incomplete or the proxy is not active", ErrorKind: "capability_missing"})
		}
	} else {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_capability", Status: "pass", Summary: "Codex is not currently using the Bingcha image-capable integration"})
	}

	imageFailure := false
	imageRequest := false
	for _, line := range strings.Split(string(logData), "\n") {
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "/v1/images/") && !strings.Contains(lower, "image_generation") && !strings.Contains(lower, "image generation") {
			continue
		}
		imageRequest = true
		if strings.Contains(lower, "failed") || strings.Contains(lower, "failure") || strings.Contains(lower, "error") || strings.Contains(lower, "401") || strings.Contains(lower, "403") || strings.Contains(lower, "429") || strings.Contains(lower, "500") || strings.Contains(lower, "502") || strings.Contains(lower, "503") || strings.Contains(lower, "upstream did not return image output") {
			imageFailure = true
		}
	}
	if imageFailure {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_recent", Status: "warn", Summary: "Recent logs contain a failed image request; inspect the error code and upstream response", ErrorKind: "recent_image_error"})
	} else if imageRequest {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_recent", Status: "pass", Summary: "Recent logs contain image requests with no explicit failure"})
	} else {
		checks = append(checks, diagnosticHealthCheck{ID: "codex.image_recent", Status: "pass", Summary: "No recent image request was found; this run did not execute a real image-generation test"})
	}
	return checks
}

func diagnosticErrorKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, fs.ErrPermission):
		return "permission_denied"
	case errors.Is(err, fs.ErrNotExist):
		return "not_found"
	case strings.Contains(strings.ToLower(err.Error()), "no space left"):
		return "disk_full"
	default:
		return "unavailable"
	}
}

func diagnosticDirectoryCheck(id, path string, verifyWrite bool) diagnosticHealthCheck {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return diagnosticHealthCheck{ID: id, Status: "warn", Summary: "directory does not exist yet and may be created during export", ErrorKind: "not_found"}
		}
		return diagnosticHealthCheck{ID: id, Status: "fail", Summary: "directory is unavailable", ErrorKind: diagnosticErrorKind(err)}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return diagnosticHealthCheck{ID: id, Status: "warn", Summary: "directory is a symbolic link; write check was skipped", ErrorKind: "symlink"}
	}
	if !info.IsDir() {
		return diagnosticHealthCheck{ID: id, Status: "fail", Summary: "path is not a directory", ErrorKind: "wrong_type"}
	}
	if !verifyWrite {
		return diagnosticHealthCheck{ID: id, Status: "pass", Summary: "directory is readable"}
	}

	tmp, err := os.CreateTemp(path, ".bingchaai-write-check-*.tmp")
	if err != nil {
		return diagnosticHealthCheck{ID: id, Status: "fail", Summary: "directory is not writable", ErrorKind: diagnosticErrorKind(err)}
	}
	tmpPath := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return diagnosticHealthCheck{ID: id, Status: "fail", Summary: "directory write check failed", ErrorKind: diagnosticErrorKind(err)}
	}
	if err := os.Remove(tmpPath); err != nil {
		return diagnosticHealthCheck{ID: id, Status: "warn", Summary: "directory is writable but temporary file cleanup failed", ErrorKind: diagnosticErrorKind(err)}
	}
	return diagnosticHealthCheck{ID: id, Status: "pass", Summary: "directory is readable and writable"}
}

func diagnosticConfigCheck(path string) diagnosticHealthCheck {
	data, err := os.ReadFile(path)
	if err != nil {
		status := "fail"
		if errors.Is(err, fs.ErrNotExist) {
			status = "warn"
		}
		return diagnosticHealthCheck{ID: "config.file", Status: status, Summary: "configuration file is unavailable", ErrorKind: diagnosticErrorKind(err)}
	}
	if !json.Valid(data) {
		return diagnosticHealthCheck{ID: "config.file", Status: "fail", Summary: "configuration file contains invalid JSON", ErrorKind: "invalid_json"}
	}
	return diagnosticHealthCheck{ID: "config.file", Status: "pass", Summary: "configuration file is readable and valid"}
}

func diagnosticConfiguredPathCheck(id, path string) diagnosticHealthCheck {
	if strings.TrimSpace(path) == "" {
		return diagnosticHealthCheck{ID: id, Status: "pass", Summary: "custom path is not configured; automatic detection is used"}
	}
	info, err := os.Stat(path)
	if err != nil {
		return diagnosticHealthCheck{ID: id, Status: "warn", Summary: "configured path is unavailable", ErrorKind: diagnosticErrorKind(err)}
	}
	kind := "special file"
	if info.Mode().IsRegular() {
		kind = "file"
	} else if info.IsDir() {
		kind = "directory"
	}
	return diagnosticHealthCheck{ID: id, Status: "pass", Summary: "configured path exists as a " + kind}
}

func diagnosticLoginCheck(now time.Time, cfg Config) diagnosticHealthCheck {
	if strings.TrimSpace(cfg.UserToken) == "" {
		return diagnosticHealthCheck{ID: "account.login", Status: "warn", Summary: "user is not signed in"}
	}
	if strings.TrimSpace(cfg.UserTokenExpiry) == "" {
		return diagnosticHealthCheck{ID: "account.login", Status: "warn", Summary: "user is signed in but token expiry is unavailable"}
	}
	expiresAt, err := time.Parse(time.RFC3339, cfg.UserTokenExpiry)
	if err != nil {
		return diagnosticHealthCheck{ID: "account.login", Status: "warn", Summary: "user is signed in but token expiry is invalid", ErrorKind: "invalid_time"}
	}
	if !expiresAt.After(now) {
		return diagnosticHealthCheck{ID: "account.login", Status: "fail", Summary: "sign-in token has expired"}
	}
	return diagnosticHealthCheck{ID: "account.login", Status: "pass", Summary: "BingchaAI session token is present and its stored expiry is in the future; ChatGPT login and server validity are not checked here"}
}

// This checks local prerequisites only. It does not send credentials, refresh
// tokens, or start a Work task to claim that account permissions are verified.
func diagnosticCodexAccountChecks() []diagnosticHealthCheck {
	identity, ok, err := currentCodexOAuthIdentity()
	return diagnosticCodexAccountChecksForIdentity(identity, ok, err)
}

func diagnosticCodexAccountChecksForIdentity(identity codexOAuthIdentity, hasOAuth bool, readErr error) []diagnosticHealthCheck {
	oauth := diagnosticHealthCheck{ID: "codex.oauth_identity", Status: "pass", Summary: "Complete local ChatGPT OAuth credentials are present; server validity was not tested"}
	work := diagnosticHealthCheck{ID: "codex.work_account", Status: "warn", ErrorKind: "not_verified", Summary: "Local ChatGPT credentials are present, but Work browser account access was not tested; if authentication fails, sign in again in the official client"}
	switch {
	case readErr != nil:
		oauth.Status, oauth.ErrorKind = "warn", "credential_unreadable"
		oauth.Summary = "ChatGPT credentials could not be read or parsed; takeover must not replace an unknown login state"
		work.ErrorKind, work.Summary = "credential_unreadable", "Work browser account access cannot be assessed until ChatGPT credentials are readable"
	case !hasOAuth:
		oauth.Status, oauth.ErrorKind = "warn", "oauth_missing"
		oauth.Summary = "No complete ChatGPT OAuth login was found; a BingchaAI login or API Key is not a ChatGPT account login"
		work.ErrorKind, work.Summary = "oauth_required", "Work browser requires an authenticated ChatGPT account; stop takeover, sign in to ChatGPT in the official client, then enable takeover again"
	case codexAuthOAuthExpiryReason(identity.Raw) != "":
		oauth.Status, oauth.ErrorKind = "warn", "oauth_renewal_required"
		oauth.Summary = "ChatGPT access token is expired or nearing expiry; credentials are preserved for the official client to renew; sign in again if renewal fails"
		work.ErrorKind, work.Summary = "oauth_renewal_required", "Work browser account access is unverified and ChatGPT token renewal is required"
	}
	return []diagnosticHealthCheck{oauth, work}
}

func diagnosticProxyChecks(cfg Config, proxy HTTPProxyStatus) []diagnosticHealthCheck {
	loggedIn := strings.TrimSpace(cfg.UserToken) != ""
	running := diagnosticHealthCheck{ID: "proxy.running", Status: "pass", Summary: "local proxy is running"}
	if !proxy.Running && loggedIn {
		running.Status, running.Summary = "fail", "local proxy is stopped while user is signed in"
	} else if !proxy.Running {
		running.Summary = "local proxy is stopped while user is signed out"
	}

	port := diagnosticHealthCheck{ID: "proxy.port", Status: "pass", Summary: "configured and listening ports match"}
	if proxy.Running && proxy.ListenPort != cfg.ProxyPort {
		port.Status, port.Summary = "fail", "configured and listening ports do not match"
	} else if !proxy.Running {
		port.Status, port.Summary = "warn", "listening port cannot be verified while proxy is stopped"
	}
	return []diagnosticHealthCheck{running, port}
}

func diagnosticRelayCheck(cfg Config) diagnosticHealthCheck {
	if !strings.EqualFold(strings.TrimSpace(cfg.CodexMode), "relay") {
		return diagnosticHealthCheck{ID: "codex.relay", Status: "pass", Summary: "relay mode is not enabled"}
	}
	if strings.TrimSpace(cfg.CodexRelayBase) == "" || strings.TrimSpace(cfg.CodexRelayKey) == "" {
		return diagnosticHealthCheck{ID: "codex.relay", Status: "fail", Summary: "relay mode is enabled but required configuration is incomplete"}
	}
	return diagnosticHealthCheck{ID: "codex.relay", Status: "pass", Summary: "relay mode configuration is complete"}
}

func diagnosticLogCheck(path string, logErr error) diagnosticHealthCheck {
	if logErr == nil {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return diagnosticHealthCheck{ID: "log.desktop", Status: "fail", Summary: "desktop log is readable but not writable", ErrorKind: diagnosticErrorKind(err)}
		}
		if err := file.Close(); err != nil {
			return diagnosticHealthCheck{ID: "log.desktop", Status: "warn", Summary: "desktop log write check could not be closed cleanly", ErrorKind: diagnosticErrorKind(err)}
		}
		return diagnosticHealthCheck{ID: "log.desktop", Status: "pass", Summary: "desktop log is readable and writable"}
	}
	status := "fail"
	if errors.Is(logErr, fs.ErrNotExist) {
		status = "warn"
	}
	return diagnosticHealthCheck{ID: "log.desktop", Status: status, Summary: "desktop log is unavailable", ErrorKind: diagnosticErrorKind(logErr)}
}

func diagnosticLogCoverageFrom(data []byte, truncated bool) diagnosticLogCoverage {
	coverage := diagnosticLogCoverage{Bytes: len(data), Truncated: truncated}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		coverage.LineCount++
		stamp, _, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
			continue
		}
		if coverage.FirstAt == "" {
			coverage.FirstAt = stamp
		}
		coverage.LastAt = stamp
	}
	return coverage
}

func collectDiagnosticHealth(now time.Time, cfg Config, proxy HTTPProxyStatus, logData []byte, truncated bool, logErr error, appDataDir, destinationDir string) diagnosticHealthReport {
	checks := []diagnosticHealthCheck{
		// Health collection is intentionally read-only. The export write itself is
		// performed once, after the report has been assembled.
		diagnosticDirectoryCheck("storage.app_data", appDataDir, false),
		diagnosticDirectoryCheck("storage.export_destination", destinationDir, false),
		diagnosticConfigCheck(filepath.Join(appDataDir, "config.json")),
		diagnosticLogCheck(filepath.Join(appDataDir, "logs", "desktop.log"), logErr),
		diagnosticLoginCheck(now, cfg),
	}
	checks = append(checks, diagnosticProxyChecks(cfg, proxy)...)
	subscription := diagnosticHealthCheck{ID: "account.subscriptions", Status: "pass", Summary: "subscription state is available"}
	if strings.TrimSpace(cfg.UserToken) != "" && len(cfg.Subscriptions) == 0 {
		subscription.Status, subscription.Summary = "warn", "user is signed in but no active subscription snapshot is stored"
	}
	checks = append(checks,
		subscription,
		diagnosticRelayCheck(cfg),
		diagnosticConfiguredPathCheck("path.ide", cfg.IDEPath),
		diagnosticConfiguredPathCheck("path.hub", cfg.HubPath),
		diagnosticConfiguredPathCheck("path.codex", cfg.CodexAppPath),
		diagnosticConfiguredPathCheck("path.claude_desktop", cfg.ClaudeDesktopPath),
	)
	checks = append(checks, diagnosticImageChecks(cfg, proxy, logData)...)
	checks = append(checks, diagnosticCodexAccountChecks()...)

	overall := "pass"
	for _, check := range checks {
		if check.Status == "fail" {
			overall = "fail"
			break
		}
		if check.Status == "warn" {
			overall = "warn"
		}
	}
	return diagnosticHealthReport{
		SchemaVersion: 1,
		GeneratedAt:   now.UTC().Format(time.RFC3339),
		OverallStatus: overall,
		LogCoverage:   diagnosticLogCoverageFrom(logData, truncated),
		Checks:        checks,
	}
}

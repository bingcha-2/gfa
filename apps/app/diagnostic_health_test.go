package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func findDiagnosticCheck(t *testing.T, report diagnosticHealthReport, id string) diagnosticHealthCheck {
	t.Helper()
	for _, check := range report.Checks {
		if check.ID == id {
			return check
		}
	}
	t.Fatalf("health check %q not found", id)
	return diagnosticHealthCheck{}
}

func TestCollectDiagnosticHealthCoversPermissionsPathsAndProxy(t *testing.T) {
	now := time.Date(2026, time.August, 12, 12, 0, 0, 0, time.UTC)
	appData := t.TempDir()
	destination := filepath.Join(t.TempDir(), "中文 export folder")
	if err := os.MkdirAll(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appData, "config.json"), []byte(`{"proxyPort":48800}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(appData, "logs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appData, "logs", "desktop.log"), []byte("ready\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	existingApp := filepath.Join(t.TempDir(), "Codex App")
	if err := os.MkdirAll(existingApp, 0o700); err != nil {
		t.Fatal(err)
	}

	cfg := Config{
		ProxyPort:       48800,
		UserToken:       "not-exported",
		UserTokenExpiry: now.Add(time.Hour).Format(time.RFC3339),
		CodexAppPath:    existingApp,
		IDEPath:         filepath.Join(t.TempDir(), "missing IDE"),
		Subscriptions:   []SubscriptionSnapshot{{Id: "not-exported"}},
	}
	proxy := HTTPProxyStatus{Running: true, ListenPort: 48800, ListenAddr: "127.0.0.1:48800"}
	report := collectDiagnosticHealth(now, cfg, proxy, []byte("2026-08-12T11:59:00Z ok\n"), false, nil, appData, destination)

	for _, id := range []string{"storage.app_data", "storage.export_destination", "config.file", "log.desktop", "account.login", "proxy.running", "proxy.port", "path.codex"} {
		if got := findDiagnosticCheck(t, report, id); got.Status != "pass" {
			t.Errorf("check %s status = %q, want pass (%s)", id, got.Status, got.Summary)
		}
	}
	if got := findDiagnosticCheck(t, report, "path.ide"); got.Status != "warn" || got.ErrorKind != "not_found" {
		t.Fatalf("missing configured path check = %+v, want not_found warning", got)
	}
	if report.OverallStatus != "warn" {
		t.Fatalf("overall status = %q, want warn", report.OverallStatus)
	}
}

func TestDiagnosticHealthReportsInvalidConfigAndPortMismatch(t *testing.T) {
	now := time.Now()
	appData := t.TempDir()
	if err := os.WriteFile(filepath.Join(appData, "config.json"), []byte(`{"proxyPort":`), 0o600); err != nil {
		t.Fatal(err)
	}
	report := collectDiagnosticHealth(
		now,
		Config{ProxyPort: 48800, UserToken: "token", UserTokenExpiry: now.Add(-time.Minute).Format(time.RFC3339)},
		HTTPProxyStatus{Running: true, ListenPort: 49999},
		nil, false, os.ErrNotExist, appData, t.TempDir(),
	)
	for _, id := range []string{"config.file", "account.login", "proxy.port"} {
		if got := findDiagnosticCheck(t, report, id); got.Status != "fail" {
			t.Errorf("check %s status = %q, want fail (%s)", id, got.Status, got.Summary)
		}
	}
	if got := findDiagnosticCheck(t, report, "log.desktop"); got.Status != "warn" || got.ErrorKind != "not_found" {
		t.Fatalf("missing log check = %+v, want not_found warning", got)
	}
	if report.OverallStatus != "fail" {
		t.Fatalf("overall status = %q, want fail", report.OverallStatus)
	}
}

func TestHealthReportDoesNotContainConfiguredPaths(t *testing.T) {
	secretPath := filepath.Join(t.TempDir(), "private-user", "Claude Secret.app")
	report := collectDiagnosticHealth(
		time.Now(), Config{ClaudeDesktopPath: secretPath}, HTTPProxyStatus{}, nil, false, os.ErrNotExist,
		t.TempDir(), t.TempDir(),
	)
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(secretPath)) || bytes.Contains(data, []byte("private-user")) {
		t.Fatalf("health report leaked configured path: %s", data)
	}
}

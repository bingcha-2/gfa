package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestBuildDiagnosticErrorSummaryAggregatesAndRedacts(t *testing.T) {
	logData := []byte(strings.Join([]string{
		"2026-08-12T10:00:00Z [proxy] request #101 failed account#12345 user@example.com",
		"2026-08-12T10:01:00Z [proxy] request #202 failed account#67890 user@example.com",
		"2026-08-12T10:02:00Z [proxy] request succeeded",
		"2026-08-12T10:03:00Z [updater] warning: retrying in 30 seconds",
		"2026-08-12T10:04:00Z [代理] 启动失败，正在重试",
		`2026-08-12T10:05:00Z failed to read D:\private\auth.json`,
		"2026-08-12T10:06:00Z ⚠ 请求超时 /opt/company/auth.json",
		"2026-08-12T10:07:00Z [proxy] failed endpoint /v1/responses",
		`2026-08-12T10:08:00Z failed C:/private/auth.json`,
		"2026-08-12T10:09:00Z 读取失败 /data0/www/applogs/app.log",
		"2026-08-12T10:10:00Z failed /root/private.json",
		"2026-08-12T10:11:00Z failed /srv/app/config",
		"2026-08-12T10:12:00Z failed /app/private/config.json",
		"2026-08-12T10:13:00Z failed /api/secrets/token",
		"2026-08-12T10:14:00Z failed /v1/data/customer.db",
	}, "\n"))

	summary := buildDiagnosticErrorSummary(logData)
	for _, secret := range []string{"12345", "67890", "user@example.com"} {
		if bytes.Contains(summary, []byte(secret)) {
			t.Errorf("summary leaked %q: %s", secret, summary)
		}
	}
	if !bytes.Contains(summary, []byte("[ERROR] count=2")) {
		t.Fatalf("summary did not aggregate matching errors: %s", summary)
	}
	if !bytes.Contains(summary, []byte("[WARN] count=1")) {
		t.Fatalf("summary omitted warning: %s", summary)
	}
	if bytes.Contains(summary, []byte("request succeeded")) {
		t.Fatalf("summary included non-problem event: %s", summary)
	}
	for _, path := range []string{`D:\private\auth.json`, "/opt/company/auth.json", "C:/private/auth.json", "/data0/www/applogs/app.log", "/root/private.json", "/srv/app/config", "/app/private/config.json", "/api/secrets/token", "/v1/data/customer.db"} {
		if bytes.Contains(summary, []byte(path)) {
			t.Errorf("summary leaked absolute path %q: %s", path, summary)
		}
	}
	if bytes.Contains(summary, []byte("/v1/responses")) {
		t.Fatalf("summary retained a root path that could be a local file: %s", summary)
	}
}

func TestBuildDiagnosticErrorSummaryHandlesNoProblems(t *testing.T) {
	summary := buildDiagnosticErrorSummary([]byte("2026-08-12T10:00:00Z [proxy] started\n"))
	if !bytes.Contains(summary, []byte("No errors or warnings")) {
		t.Fatalf("unexpected empty summary: %s", summary)
	}
}

package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRedactDiagnosticText(t *testing.T) {
	secrets := []string{
		"secret-token-value",
		"dXNlcjpwYXNz",
		"refresh-cookie-value",
		"json-cookie-secret",
		"json-set-cookie-secret",
		"password-value",
		"plain-token-value",
		"query-key-value",
		"person@example.com",
		"sk-abcdefghijklmnop",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
		"lixuezhi004",
		"url-user:url-password",
		"C:/private/auth.json",
		"/data0/www/applogs/app.log",
		"123e4567-e89b-42d3-a456-426614174000",
		"account#12345",
		"acct=67890",
		"routeAcct=24680",
	}
	input := strings.Join([]string{
		"useful proxy failure context",
		"Authorization: Bearer secret-token-value",
		"Authorization: Basic dXNlcjpwYXNz",
		"Cookie: session=a; refresh=refresh-cookie-value",
		`{"authorization":"Basic dXNlcjpwYXNz"}`,
		`{"cookie":"session=json-cookie-secret"}`,
		`{"set-cookie":"refresh=json-set-cookie-secret"}`,
		`{"password":"password-value"}`,
		"token=plain-token-value",
		"request=https://example.com/v1?key=query-key-value",
		"email=person@example.com",
		"api_key=sk-abcdefghijklmnop",
		"jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
		`path=C:\Users\lixuezhi004\AppData\Local`,
		"proxy=https://url-user:url-password@example.com",
		"windows-path=C:/private/auth.json",
		"unix-path=/data0/www/applogs/app.log",
		"endpoint=/v1/responses",
		"deviceId: 123e4567-e89b-42d3-a456-426614174000",
		"selected account#12345 acct=67890 routeAcct=24680",
	}, "\n")

	got := redactDiagnosticText(input)
	for _, secret := range secrets {
		if strings.Contains(got, secret) {
			t.Errorf("redacted output leaked %q: %s", secret, got)
		}
	}
	if !strings.Contains(got, "useful proxy failure context") {
		t.Fatalf("redaction removed useful context: %s", got)
	}
	if strings.Contains(got, "/v1/responses") {
		t.Fatalf("redaction retained a root path that could be a local file: %s", got)
	}
}

func TestKeepDiagnosticTailIsBoundedAndValidUTF8(t *testing.T) {
	data := []byte(strings.Repeat("旧日志", 20) + "newest")
	got := keepDiagnosticTail(data, 31)
	if len(got) > 31 {
		t.Fatalf("tail length = %d, want <= 31", len(got))
	}
	if !utf8.Valid(got) {
		t.Fatalf("tail is not valid UTF-8: %q", got)
	}
	if !bytes.HasSuffix(got, []byte("newest")) {
		t.Fatalf("tail does not keep newest content: %q", got)
	}
}

func TestReadFileTailIsBoundedAndKeepsNewestLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desktop.log")
	data := []byte("old-line-111111\nold-line-222222\nnewest-line\n")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	got, truncated, err := readFileTail(path, 28)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("expected truncated tail")
	}
	if len(got) > 28 {
		t.Fatalf("tail length = %d, want <= 28", len(got))
	}
	if !bytes.Contains(got, []byte("newest-line")) {
		t.Fatalf("tail does not contain newest line: %q", got)
	}
	if bytes.Contains(got, []byte("old-line-111111")) {
		t.Fatalf("tail retained oldest line: %q", got)
	}
}

func TestDiagnosticSafeConfigDoesNotContainSensitiveValues(t *testing.T) {
	cfg := Config{
		AccountCard:        "card-secret",
		DeviceId:           "device-secret",
		ProxyPort:          48800,
		IDEPath:            `C:\Users\private\IDE`,
		HubPath:            "/home/private/hub",
		CodexAppPath:       "/Applications/Codex.app",
		ClaudeDesktopPath:  "/Applications/Claude.app",
		UserToken:          "user-token-secret",
		UserEmail:          "private@example.com",
		UserId:             "user-secret",
		CodexMode:          "relay",
		CodexRelayBase:     "https://secret-relay.example.com",
		CodexRelayKey:      "relay-secret",
		CodexRelayProtocol: "chat",
		CodexModelMap:      map[string]string{"model-a": "private-model"},
		Subscriptions:      []SubscriptionSnapshot{{Id: "subscription-secret"}},
	}

	data, err := json.Marshal(makeDiagnosticSafeConfig(cfg))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"card-secret", "device-secret", "private", "user-token-secret",
		"private@example.com", "user-secret", "secret-relay", "relay-secret",
		"model-a", "private-model", "subscription-secret",
	} {
		if bytes.Contains(data, []byte(secret)) {
			t.Errorf("safe config leaked %q: %s", secret, data)
		}
	}
	if !bytes.Contains(data, []byte(`"loggedIn":true`)) || !bytes.Contains(data, []byte(`"subscriptionCount":1`)) {
		t.Fatalf("safe config omitted useful summary: %s", data)
	}
}

func TestBuildDiagnosticBundleContainsOnlyExpectedRedactedFiles(t *testing.T) {
	report := makeDiagnosticReport(time.Unix(1, 0), HTTPProxyStatus{
		Running: true, ListenAddr: "127.0.0.1:48800", ListenPort: 48800,
	}, 32, false, nil)
	bundle, err := buildDiagnosticBundle(
		report,
		makeDiagnosticSafeConfig(Config{ProxyPort: 48800}),
		diagnosticHealthReport{SchemaVersion: 1, OverallStatus: "pass"},
		[]byte("request Authorization: Bearer top-secret-token from user@example.com\n"),
	)
	if err != nil {
		t.Fatal(err)
	}

	reader, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		t.Fatal(err)
	}
	wantNames := []string{"error-summary.txt", "health-check.json", "logs/desktop.log", "report.json", "safe-config.json"}
	if len(reader.File) != len(wantNames) {
		t.Fatalf("zip has %d files, want %d", len(reader.File), len(wantNames))
	}
	for i, file := range reader.File {
		if file.Name != wantNames[i] {
			t.Errorf("zip file %d = %q, want %q", i, file.Name, wantNames[i])
		}
		entry, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(entry)
		_ = entry.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(content, []byte("top-secret-token")) || bytes.Contains(content, []byte("user@example.com")) {
			t.Errorf("zip entry %q leaked sensitive log content: %s", file.Name, content)
		}
	}
}

func TestNormalizeDiagnosticPathUsesZipExtension(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  string
	}{
		{input: "diagnostics", want: "diagnostics.zip"},
		{input: "diagnostics.txt", want: "diagnostics.txt.zip"},
		{input: "diagnostics.ZIP", want: "diagnostics.ZIP"},
	} {
		got, err := normalizeDiagnosticPath(tc.input)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(got) != tc.want {
			t.Errorf("normalizeDiagnosticPath(%q) = %q, want base %q", tc.input, got, tc.want)
		}
	}
}

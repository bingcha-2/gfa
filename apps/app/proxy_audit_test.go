package main

import (
	"errors"
	"strings"
	"testing"
)

func TestProxyAuditEmitShowsClaudeTransportMessageWithoutAuditMetadata(t *testing.T) {
	ClearInMemoryLogs()
	rawErr := `read tcp 198.18.0.1:53930->216.175.200.154:443: wsarecv: An existing connection was forcibly closed by the remote host.`

	audit := newProxyAudit("claude", 96, "生成", "POST", "/v1/messages")
	audit.target = "https://api.anthropic.com/v1/messages?beta=true"
	audit.model = "claude-opus-4-8"
	audit.accountID = 6
	audit.token = "sk-ant-test-token"
	audit.status = 502
	audit.note = claudeTransportAuditNote(errors.New(rawErr))

	audit.emit()

	logs := GetInMemoryLogs()
	if len(logs) != 1 {
		t.Fatalf("logs len = %d, want 1", len(logs))
	}
	got := logs[0]
	if !strings.Contains(got, claudeTransportFriendlyMessage) {
		t.Fatalf("log = %q, want friendly message %q", got, claudeTransportFriendlyMessage)
	}
	if !strings.Contains(got, "原始错误: ") || !strings.Contains(got, "wsarecv") || !strings.Contains(got, "forcibly closed") {
		t.Fatalf("log = %q, want sanitized transport details", got)
	}
	if strings.Contains(got, "198.18.0.1") || strings.Contains(got, "216.175.200.154") {
		t.Fatalf("log = %q leaked raw IP details", got)
	}
	for _, leaked := range []string{"[claude-proxy]", "#96", "POST /v1/messages", "model=", "acct=", "token=", "码=", "备注=", "上游请求失败"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("log = %q leaked audit prefix %q", got, leaked)
		}
	}
}

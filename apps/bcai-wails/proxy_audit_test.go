package main

import (
	"strings"
	"testing"
)

func TestProxyAuditEmitShowsOnlyClaudeFriendlyTransportMessage(t *testing.T) {
	ClearInMemoryLogs()

	audit := newProxyAudit("claude", 96, "生成", "POST", "/v1/messages")
	audit.target = "https://api.anthropic.com/v1/messages?beta=true"
	audit.model = "claude-opus-4-8"
	audit.accountID = 6
	audit.token = "sk-ant-test-token"
	audit.status = 502
	audit.note = claudeTransportAuditNote("上游请求失败(Do err):", nil)

	audit.emit()

	logs := GetInMemoryLogs()
	if len(logs) != 1 {
		t.Fatalf("logs len = %d, want 1", len(logs))
	}
	got := logs[0]
	if !strings.Contains(got, claudeTransportFriendlyMessage) {
		t.Fatalf("log = %q, want friendly message %q", got, claudeTransportFriendlyMessage)
	}
	for _, leaked := range []string{"[claude-proxy]", "#96", "POST /v1/messages", "model=", "acct=", "token=", "码=", "备注=", "上游请求失败"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("log = %q leaked audit prefix %q", got, leaked)
		}
	}
}

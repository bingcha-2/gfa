package main

import (
	"strings"
	"testing"
)

func TestCodexModelMismatchKeepsReport(t *testing.T) {
	d := codexStreamDiagnostic{RequestedModel: "gpt-6-astra", SentModel: "gpt-6-astra"}
	d.observe([]byte(`{"type":"response.completed","response":{"status":"completed","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`))
	if !strings.Contains(d.reportReason(nil, 2), "model_mismatch=true") || d.RequestedModel != "gpt-6-astra" {
		t.Fatalf("missing mismatch: %s", d.summary(nil))
	}
}

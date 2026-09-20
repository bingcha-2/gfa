package main

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexStreamDiagnosticForwarding(t *testing.T) {
	cases := []struct {
		name, body, result, code string
		tokens                   int64
	}{
		{"overloaded", `data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}`, "failed", "server_is_overloaded", 0},
		{"error", `data: {"type":"error","code":"slow_down","message":"slow","request_id":"req_123"}`, "failed", "slow_down", 0},
		{"event fallback", "event: error\ndata: {\"error\":{\"code\":\"slow_down\"}}", "failed", "slow_down", 0},
		{"completed", `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`, "completed", "", 12},
		{"done failed", `data: {"type":"response.done","response":{"status":"failed","error":{"code":"quota"}}}`, "failed", "quota", 0},
		{"incomplete", `data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}`, "incomplete", "max_output_tokens", 0},
		{"missing end", "data: {\"type\":\"response.created\"}\n\ndata: [DONE]", "missing_completion", "", 0},
		{"malformed", "data: {broken}", "missing_completion", "", 0},
		{"plain response", `{"status":"completed","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}`, "completed", "", 12},
		{"failed then done", "data: {\"type\":\"response.failed\"}\n\ndata: {\"type\":\"response.done\"}", "failed", "", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			d := &codexStreamDiagnostic{}
			_, _, _, _, total, err := copyStreamingCodexResponse(w, &diagnosticChunkReader{data: []byte(tc.body)}, d)
			if err != nil || total != tc.tokens || w.Body.String() != tc.body {
				t.Fatalf("forwarding/accounting changed: err=%v total=%d body=%q", err, total, w.Body.String())
			}
			if !strings.Contains(d.summary(err), "stream_result="+tc.result) || d.Code != tc.code {
				t.Fatalf("diagnostic: %s", d.summary(err))
			}
		})
	}
}

type diagnosticChunkReader struct{ data []byte }

func (r *diagnosticChunkReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := 3
	if len(r.data) < n {
		n = len(r.data)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

func TestCodexStreamDiagnosticRedactionAndSummary(t *testing.T) {
	id := "b65625d8-772f-4d75-84bd-929c8fc8756e"
	d := &codexStreamDiagnostic{RequestID: id}
	d.observe([]byte(`data: {"type":"response.failed","response":{"output":[{"text":"PRIVATE_RESPONSE"}],"error":{"code":"slow_down","message":"busy api_key=sk-supersecret123 email=user@example.com\nretry"}}}`))
	note := d.summary(nil)
	for _, secret := range []string{"sk-supersecret123", "user@example.com", "PRIVATE_RESPONSE", "\n"} {
		if strings.Contains(note, secret) {
			t.Fatalf("leak: %q", note)
		}
	}
	line := "2026-09-06T22:50:00+08:00 [codex-proxy] #69 " + note
	exported := redactDiagnosticText(line)
	if !strings.Contains(exported, id) {
		t.Fatalf("request ID lost: %s", exported)
	}
	if !strings.Contains(string(buildDiagnosticErrorSummary([]byte(line))), "slow_down") {
		t.Fatal("failure absent from summary")
	}
	if !strings.Contains(d.summary(errors.New("connection reset")), "stream_result=interrupted") {
		t.Fatal("missing transport result")
	}
	if codexDiagnosticID("bad\nheader") != "invalid" {
		t.Fatal("unsafe ID")
	}
	if strings.Contains(redactDiagnosticText("account_id="+id), id) {
		t.Fatal("account UUID exposed")
	}
}

type diagnosticBrokenReader struct{}

func (diagnosticBrokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestCodexStreamDiagnosticTransportFailure(t *testing.T) {
	d := &codexStreamDiagnostic{}
	_, _, _, _, _, err := copyStreamingCodexResponse(httptest.NewRecorder(), diagnosticBrokenReader{}, d)
	if !errors.Is(err, io.ErrUnexpectedEOF) || !strings.Contains(d.summary(err), "stream_result=interrupted") {
		t.Fatalf("transport error changed: %v, %s", err, d.summary(err))
	}
}

func TestCodexStreamUsageEvidence(t *testing.T) {
	cases := []struct {
		name, body, state string
		malformed         int
	}{
		{"missing", `data: {"type":"response.completed","response":{}}`, "missing", 0},
		{"null", `data: {"type":"response.completed","response":{"usage":null}}`, "missing", 0},
		{"empty", `data: {"type":"response.completed","response":{"usage":{}}}`, "unrecognized", 0},
		{"explicit zero", `data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}`, "explicit_zero", 0},
		{"null counts", `data: {"type":"response.completed","response":{"usage":{"input_tokens":null,"output_tokens":null}}}`, "unrecognized", 0},
		{"wrong count type", `data: {"type":"response.completed","response":{"usage":{"input_tokens":"0","output_tokens":"0"}}}`, "unrecognized", 0},
		{"unexpected shape", `data: {"type":"response.completed","response":{"usage":[0,0]}}`, "unrecognized", 0},
		{"malformed", "data: {broken}\n\ndata: [DONE]\n\n", "missing", 1},
		{"parsed", `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}`, "parsed", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &codexStreamDiagnostic{RequestID: "req_evidence"}
			w := httptest.NewRecorder()
			_, _, _, _, total, err := copyStreamingCodexResponse(w, &diagnosticChunkReader{data: []byte(tc.body)}, d)
			if err != nil || w.Body.String() != tc.body {
				t.Fatalf("forwarding changed: %v", err)
			}
			if !strings.Contains(d.summary(err), "usage_state="+tc.state) || d.MalformedEvents != tc.malformed {
				t.Fatalf("wrong evidence: %s", d.summary(err))
			}
			reason := d.reportReason(err, total)
			if tc.state == "parsed" {
				if reason != "" {
					t.Fatalf("normal success reported as anomaly: %s", reason)
				}
			} else if !strings.Contains(reason, "codex_stream_diagnostic") || !strings.Contains(reason, "req_evidence") {
				t.Fatalf("missing server evidence: %s", reason)
			}
		})
	}
}

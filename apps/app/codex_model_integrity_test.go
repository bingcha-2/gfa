package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexTranslatedModelIntegrity(t *testing.T) {
	for _, actual := range []string{"gpt-5.6-luna", ""} {
		t.Run(actual, func(t *testing.T) {
			chunk := `{"model":"` + actual + `","choices":[{"message":{"content":"hello"},"delta":{"content":"hello"},"finish_reason":"stop"}]}`
			var response struct {
				Model string `json:"model"`
			}
			if err := json.Unmarshal(convertChatToResponsesJSON([]byte(chunk), "gpt-6-astra", 1), &response); err != nil {
				t.Fatal(err)
			}
			if response.Model != actual {
				t.Fatalf("response model=%q want=%q", response.Model, actual)
			}
			var out bytes.Buffer
			d := codexStreamDiagnostic{RequestedModel: "gpt-6-astra", SentModel: "gpt-6-astra"}
			_, _, _, err := streamChatToResponses(&out, strings.NewReader("data: "+chunk+"\n\ndata: [DONE]\n\n"), "gpt-6-astra", 1, &d)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(out.String(), `"model":"gpt-6-astra"`) || d.UpstreamModel != actual {
				t.Fatalf("model fabricated: %s", out.String())
			}
			if d.modelMismatch() != (actual != "") {
				t.Fatalf("diagnostic=%s", d.summary(nil))
			}
		})
	}
}

func TestCodexChatFailureDoesNotComplete(t *testing.T) {
	for _, body := range []string{
		`data: {"error":{"code":"invalid_prompt","message":"rejected"}}` + "\n\n",
		`data: {"choices":[{"delta":{"content":"partial"}}]}` + "\n\n",
	} {
		var out bytes.Buffer
		_, _, _, err := streamChatToResponses(&out, strings.NewReader(body), "gpt-6-astra", 1)
		if err == nil || strings.Contains(out.String(), "response.completed") {
			t.Fatalf("failure reported as completed: err=%v out=%s", err, out.String())
		}
	}
}

func TestCodexChatJSONFailureDoesNotComplete(t *testing.T) {
	for _, body := range []string{`{"error":{"code":"invalid_prompt","message":"rejected"}}`, `{}`, `not json`} {
		out := convertChatToResponsesJSON([]byte(body), "gpt-6-astra", 1)
		var result struct {
			Status string `json:"status"`
			Model  string `json:"model"`
		}
		if err := json.Unmarshal(out, &result); err != nil {
			t.Fatal(err)
		}
		if result.Status != "failed" || result.Model != "" {
			t.Fatalf("invalid response fabricated success: %s", out)
		}
	}
}

func TestGPT6ChatStateRejectedBeforeUpstream(t *testing.T) {
	called := false
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; _, _ = io.WriteString(w, `{}`) }))
	defer up.Close()
	p := &CodexProxy{relay: &CodexRelayConfig{BaseURL: up.URL, APIKey: "test", Protocol: "chat"}}
	for _, extra := range []string{
		`"tools":[{"type":"function","name":"run"}]`,
		`"input":[{"type":"reasoning","encrypted_content":"opaque"}]`,
		`"input":[{"type":"compaction","encrypted_content":"opaque"}]`,
		`"previous_response_id":"resp_1"`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-6-astra",`+extra+`}`))
		w := httptest.NewRecorder()
		p.ServeHTTP(w, req, "", "test-device", "")
		if w.Code != 400 || !strings.Contains(w.Body.String(), "Responses") || called {
			t.Fatalf("unsupported request was not stopped: %d %s called=%v", w.Code, w.Body.String(), called)
		}
	}
	if reason := codexChatCompatibilityError([]byte(`{"input":"hello"}`), "gpt-6-astra"); reason != "" {
		t.Fatal(reason)
	}
}

func TestCodexModelMismatchKeepsReport(t *testing.T) {
	d := codexStreamDiagnostic{RequestedModel: "gpt-6-astra", SentModel: "gpt-6-astra"}
	d.observe([]byte(`{"type":"response.completed","response":{"status":"completed","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`))
	if !strings.Contains(d.reportReason(nil, 2), "model_mismatch=true") || d.RequestedModel != "gpt-6-astra" {
		t.Fatalf("missing mismatch: %s", d.summary(nil))
	}
}

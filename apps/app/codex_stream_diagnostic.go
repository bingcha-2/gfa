package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Observational only: never changes forwarding, retries or usage accounting.
type codexStreamDiagnostic struct {
	ObservationLimited                       bool
	ReasoningEffort, ResponseID              string
	Result, Code, Message, RequestID         string
	event                                    string
	UsageState                               string
	MalformedEvents                          int
	RequestedModel, SentModel, UpstreamModel string
}

func (d *codexStreamDiagnostic) observe(line []byte) {
	line = bytes.TrimSpace(line)
	if bytes.HasPrefix(line, []byte("event:")) {
		d.event = strings.TrimSpace(string(bytes.TrimPrefix(line, []byte("event:"))))
		return
	}
	if len(line) == 0 {
		d.event = ""
		return
	}
	data := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return
	}
	// Decode only metadata, never retain response output or request content.
	type streamError struct{ Code, Message string }
	var event struct {
		Type      string `json:"type"`
		Model     string `json:"model"`
		ID        string `json:"id"`
		Reasoning struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		Code      string       `json:"code"`
		Message   string       `json:"message"`
		RequestID string       `json:"request_id"`
		Error     *streamError `json:"error"`
		Response  struct {
			Reasoning struct {
				Effort string `json:"effort"`
			} `json:"reasoning"`
			ID                string       `json:"id"`
			Model             string       `json:"model"`
			Status            string       `json:"status"`
			Error             *streamError `json:"error"`
			IncompleteDetails struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
	}
	if json.Unmarshal(data, &event) != nil {
		d.MalformedEvents++
		return
	}
	if event.Response.Model != "" {
		d.UpstreamModel = event.Response.Model
	} else if event.Model != "" {
		d.UpstreamModel = event.Model
	}
	if event.Response.Reasoning.Effort != "" {
		d.ReasoningEffort = codexDiagnosticText(event.Response.Reasoning.Effort)
	} else if event.Reasoning.Effort != "" {
		d.ReasoningEffort = codexDiagnosticText(event.Reasoning.Effort)
	}
	if event.Response.ID != "" {
		d.ResponseID = event.Response.ID
	} else if strings.HasPrefix(event.ID, "resp_") {
		d.ResponseID = event.ID
	}
	if d.RequestID == "" {
		d.RequestID = event.RequestID
	}
	if bytes.Contains(data, []byte(`"usage"`)) {
		d.observeUsage(data)
	}
	typ := event.Type
	if typ == "" {
		typ = d.event
	}
	if typ == "" && event.Response.Status == "" {
		// Non-streaming Responses JSON has status at the root.
		var response struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(data, &response) == nil {
			event.Response.Status = response.Status
		}
	}
	failed := typ == "error" || typ == "response.failed" || event.Response.Status == "failed" || event.Error != nil
	incomplete := typ == "response.incomplete" || event.Response.Status == "incomplete"
	if failed || incomplete {
		d.Result = "failed"
		if incomplete {
			d.Result = "incomplete"
		}
		d.Code, d.Message = event.Code, event.Message
		if event.Error != nil {
			d.Code, d.Message = event.Error.Code, event.Error.Message
		}
		if event.Response.Error != nil {
			d.Code, d.Message = event.Response.Error.Code, event.Response.Error.Message
		}
		if incomplete && d.Code == "" {
			d.Code = event.Response.IncompleteDetails.Reason
		}
		if d.RequestID == "" {
			d.RequestID = event.RequestID
		}
	} else if d.Result == "" && (typ == "response.completed" || event.Response.Status == "completed" || typ == "response.done") {
		d.Result = "completed"
	}
}

// Keep only usage classification, never request/response content. In particular,
// absent or malformed usage must not be presented as an upstream-confirmed zero.
func (d *codexStreamDiagnostic) observeUsage(data []byte) {
	var payload struct {
		Usage    json.RawMessage `json:"usage"`
		Response struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"response"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return
	}
	raw := payload.Usage
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		raw = payload.Response.Usage
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return
	}
	state := "unrecognized"
	if _, _, _, _, ok := codexUsageFromJSON(data); ok {
		state = "parsed"
	} else {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) == nil {
			// Require explicit numeric input AND output; an empty object is unknown.
			isZero := func(names ...string) bool {
				for _, name := range names {
					value, exists := fields[name]
					if !exists {
						continue
					}
					var number float64
					return !bytes.Equal(value, []byte("null")) && json.Unmarshal(value, &number) == nil && number == 0
				}
				return false
			}
			if isZero("input_tokens", "prompt_tokens") && isZero("output_tokens", "completion_tokens") {
				state = "explicit_zero"
			}
		}
	}
	// A later unrelated metadata frame cannot erase successfully parsed usage.
	if d.UsageState != "parsed" {
		d.UsageState = state
	}
}

func (d *codexStreamDiagnostic) reportReason(copyErr error, total int64) string {
	if copyErr == nil && d.Result == "completed" && total > 0 && !d.modelMismatch() {
		return ""
	}
	return "codex_stream_diagnostic " + d.summary(copyErr)
}

// A difference is observable routing metadata, not proof of answer quality.
func (d *codexStreamDiagnostic) modelMismatch() bool {
	return d.SentModel != "" && d.UpstreamModel != "" && d.SentModel != d.UpstreamModel
}

func codexDiagnosticText(value string) string {
	value = strings.Join(strings.Fields(redactDiagnosticText(value)), " ")
	runes := []rune(value)
	if len(runes) > 400 {
		value = string(runes[:400]) + "..."
	}
	return value
}

// IDs are restricted to correlation-safe characters, not arbitrary header text.
func codexDiagnosticID(value string) string {
	if len(value) > 128 {
		return "invalid"
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return "invalid"
		}
	}
	return value
}

func (d *codexStreamDiagnostic) summary(copyErr error) string {
	result := d.Result
	if copyErr != nil {
		result = "interrupted"
	} else if result == "" {
		result = "missing_completion"
	}
	level := ""
	if result != "completed" {
		level = "[ERROR] "
	}
	note := fmt.Sprintf("%sstream_result=%s request_id=%s", level, result, codexDiagnosticID(d.RequestID))
	if d.ReasoningEffort != "" {
		note += fmt.Sprintf(" reasoning_effort=%q", codexDiagnosticText(d.ReasoningEffort))
	}
	if d.ResponseID != "" {
		note += fmt.Sprintf(" response_id=%q", codexDiagnosticID(d.ResponseID))
	}
	if d.ObservationLimited {
		note += " observation_limited=true"
	}
	if d.RequestedModel != "" || d.SentModel != "" {
		note += fmt.Sprintf(" requested_model=%q sent_model=%q upstream_model=%q model_mismatch=%t",
			codexDiagnosticText(d.RequestedModel), codexDiagnosticText(d.SentModel), codexDiagnosticText(d.UpstreamModel), d.modelMismatch())
	}
	usageState := d.UsageState
	if usageState == "" {
		usageState = "missing"
	}
	note += fmt.Sprintf(" usage_state=%s malformed_events=%d", usageState, d.MalformedEvents)
	if d.Code != "" {
		note += fmt.Sprintf(" error.code=%q", codexDiagnosticText(d.Code))
	}
	if d.Message != "" {
		note += fmt.Sprintf(" error.message=%q", codexDiagnosticText(d.Message))
	}
	if copyErr != nil {
		note += fmt.Sprintf(" transport_error=%q", codexDiagnosticText(copyErr.Error()))
	}
	return note
}

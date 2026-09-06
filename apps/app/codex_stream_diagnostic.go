package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Observational only: never changes forwarding, retries or usage accounting.
type codexStreamDiagnostic struct {
	Result, Code, Message, RequestID string
	event                            string
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
	// Decode only metadata, never retain response output or request content.
	type streamError struct{ Code, Message string }
	var event struct {
		Type      string       `json:"type"`
		Code      string       `json:"code"`
		Message   string       `json:"message"`
		RequestID string       `json:"request_id"`
		Error     *streamError `json:"error"`
		Response  struct {
			Status            string       `json:"status"`
			Error             *streamError `json:"error"`
			IncompleteDetails struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
	}
	if json.Unmarshal(data, &event) != nil {
		return
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
	failed := typ == "error" || typ == "response.failed" || event.Response.Status == "failed"
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

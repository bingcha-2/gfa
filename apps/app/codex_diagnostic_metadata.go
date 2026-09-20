package main

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/tidwall/gjson"
	"net/http"
	"strings"
	"sync"
)

// Metadata only. Never include prompts, credentials or opaque upstream state.
type CodexRequestDiagnostic struct {
	ObservationLimited bool   `json:"observationLimited,omitempty"`
	Result             string `json:"result"`
	ErrorCode          string `json:"errorCode,omitempty"`
	RequestedModel     string `json:"requestedModel,omitempty"`
	SentModel          string `json:"sentModel,omitempty"`
	UpstreamModel      string `json:"upstreamModel,omitempty"`
	ReasoningEffort    string `json:"reasoningEffort,omitempty"`
	RequestID          string `json:"requestId,omitempty"`
	ResponseID         string `json:"responseId,omitempty"`
	SessionHash        string `json:"sessionHash,omitempty"`
	EgressFingerprint  string `json:"egressFingerprint,omitempty"`
	EgressChanged      bool   `json:"egressChanged,omitempty"`
	AccountChanged     bool   `json:"accountChanged,omitempty"`
}

type codexContinuityEntry struct {
	account int
	route   string
}
type codexContinuity struct {
	mu      sync.Mutex
	entries map[string]codexContinuityEntry
}

func (c *codexContinuity) observe(key string, account int, route string) (bool, bool) {
	if key == "" {
		return false, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]codexContinuityEntry)
	}
	previous, exists := c.entries[key]
	if !exists && len(c.entries) >= 2048 {
		for old := range c.entries {
			delete(c.entries, old)
			break
		}
	}
	c.entries[key] = codexContinuityEntry{account, route}
	return exists && previous.account != account, exists && previous.route != route
}

func codexContinuityKey(card, device, session string) string {
	if session == "" {
		return ""
	}
	return codexOpaqueHash(card + "\x00" + device + "\x00" + session)
}

func codexOpaqueHash(value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func codexSessionHash(h http.Header, body []byte) string {
	for _, key := range []string{"Session-Id", "Session_id", "Thread-Id", "Thread_id"} {
		if value := h.Get(key); value != "" {
			return codexOpaqueHash(value)
		}
	}
	for _, key := range []string{"client_metadata.session_id", "client_metadata.thread_id", "response.client_metadata.session_id", "response.client_metadata.thread_id"} {
		if value := gjson.GetBytes(body, key).String(); value != "" {
			return codexOpaqueHash(value)
		}
	}
	return ""
}

func codexReasoningEffort(body []byte) string {
	value := gjson.GetBytes(body, "reasoning.effort").String()
	if value == "" {
		value = gjson.GetBytes(body, "response.reasoning.effort").String()
	}
	if value == "" {
		value = gjson.GetBytes(body, "reasoning_effort").String()
	}
	return codexDiagnosticText(value)
}

func (d *codexStreamDiagnostic) metadata(status int, copyErr error) *CodexRequestDiagnostic {
	result := d.Result
	if copyErr != nil && result != "failed" {
		result = "interrupted"
	}
	if result == "" {
		if status >= 400 {
			result = "failed"
		} else {
			result = "missing_completion"
		}
	}
	return &CodexRequestDiagnostic{
		ObservationLimited: d.ObservationLimited,
		Result:             result, ErrorCode: codexDiagnosticText(d.Code), RequestedModel: codexDiagnosticText(d.RequestedModel),
		SentModel: codexDiagnosticText(d.SentModel), UpstreamModel: codexDiagnosticText(d.UpstreamModel),
		ReasoningEffort: d.ReasoningEffort, RequestID: codexDiagnosticID(d.RequestID), ResponseID: codexDiagnosticID(d.ResponseID),
	}
}

// A configured exit identifies the route, not its public IP. A rotating proxy may
// change IP without changing configuration; this fingerprint makes no IP claim.
func codexEgressFingerprint(lease *CodexTokenLease, userProxy string) string {
	if lease == nil {
		return ""
	}
	if lease.IsRelay() {
		return codexOpaqueHash("relay-direct")
	}
	if strings.TrimSpace(lease.ProxyURL) != "" {
		return codexOpaqueHash("bound:" + strings.TrimSpace(lease.ProxyURL))
	}
	return codexOpaqueHash("local:" + strings.TrimSpace(userProxy))
}

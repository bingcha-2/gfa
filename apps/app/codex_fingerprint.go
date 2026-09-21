package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Identity is issued by the account server, so all installations leasing an
// account share it. Local database IDs and rotating access tokens are not seeds.
type CodexFingerprint struct {
	Mode           string                  `json:"mode"`
	InstallationID string                  `json:"installationId"`
	SessionID      string                  `json:"sessionId"`
	Namespace      string                  `json:"namespace"`
	Client         *CodexFingerprintClient `json:"client,omitempty"`
}

type CodexFingerprintClient struct {
	UserAgent  string `json:"userAgent"`
	Originator string `json:"originator"`
	Version    string `json:"version"`
}

// Normalize only client identity. Authorization, model/beta capabilities,
// response continuity state, and per-turn request IDs remain untouched.
func applyCodexFingerprintClientHeaders(h http.Header, f *CodexFingerprint) {
	if h == nil || f == nil {
		return
	}
	profile := CodexFingerprintClient{UserAgent: codexDefaultUserAgent, Originator: codexDefaultOriginator, Version: "0.155.0"}
	if f.Client != nil && f.Client.UserAgent != "" && f.Client.Originator != "" && f.Client.Version != "" {
		profile = *f.Client
	}
	for key := range h {
		name := strings.ToLower(key)
		if strings.HasPrefix(name, "sec-ch-ua") || strings.HasPrefix(name, "x-stainless-") || name == "forwarded" || strings.HasPrefix(name, "x-forwarded-") || name == "x-real-ip" || name == "true-client-ip" || name == "cf-connecting-ip" {
			delete(h, key)
		}
	}
	h.Set("User-Agent", profile.UserAgent)
	h.Set("Originator", profile.Originator)
	h.Set("Version", profile.Version)
}

func codexLeaseFingerprint(lease *CodexTokenLease) *CodexFingerprint {
	if lease == nil || lease.IsRelay() || lease.Fingerprint == nil {
		return nil
	}
	f := lease.Fingerprint
	if f.Mode != "device" && f.Mode != "session" && f.Mode != "full" {
		return nil
	}
	for _, id := range []string{f.InstallationID, f.SessionID, f.Namespace} {
		parsed, err := uuid.Parse(id)
		if err != nil || parsed == uuid.Nil {
			return nil
		}
	}
	return f
}

func applyCodexFingerprintProbe(h http.Header, lease *CodexTokenLease) {
	if f := codexLeaseFingerprint(lease); f != nil {
		h.Set("X-Codex-Installation-Id", f.InstallationID)
		applyCodexFingerprintClientHeaders(h, f)
	}
}

func prepareCodexFingerprintRequest(req *http.Request, body []byte, lease *CodexTokenLease, clientID string) []byte {
	applyCodexFingerprintURL(req.URL, lease)
	next := applyCodexFingerprint(body, req.Header, lease, clientID)
	req.Body = io.NopCloser(bytes.NewReader(next))
	req.ContentLength = int64(len(next))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(next)), nil }
	return next
}

// Model discovery can carry the client version in the URL as well as headers.
// Preserve unrelated query parameters and leave absent version hints absent.
func applyCodexFingerprintURL(target *url.URL, lease *CodexTokenLease) {
	f := codexLeaseFingerprint(lease)
	if target == nil || f == nil {
		return
	}
	query := target.Query()
	if !query.Has("client_version") {
		return
	}
	headers := http.Header{}
	applyCodexFingerprintClientHeaders(headers, f)
	query.Set("client_version", headers.Get("Version"))
	target.RawQuery = query.Encode()
}

// Adapted behavior from sub2api's fingerprint modes, implemented for GFA's
// distributed lease protocol. Preserve turn IDs and timestamps: retries and WS
// turns must retain their original semantics. Rebuild from original input on
// account failover, never from a previous account's rewritten request.
func applyCodexFingerprint(body []byte, headers http.Header, lease *CodexTokenLease, clientID string) []byte {
	f := codexLeaseFingerprint(lease)
	if f == nil {
		return body
	}
	if len(body) > 0 && (!gjson.ValidBytes(body) || !gjson.ParseBytes(body).IsObject()) {
		return body
	}
	// Only response.create frames carry request metadata; leave WS control frames alone.
	if kind := gjson.GetBytes(body, "type").String(); kind != "" && kind != "response.create" {
		return body
	}
	cm := map[string]any{}
	if raw := gjson.GetBytes(body, "client_metadata"); raw.IsObject() {
		decoder := json.NewDecoder(strings.NewReader(raw.Raw))
		decoder.UseNumber()
		_ = decoder.Decode(&cm)
	}
	first := func(values ...string) string {
		for _, value := range values {
			if strings.TrimSpace(value) != "" {
				return value
			}
		}
		return ""
	}
	str := func(key string) string { value, _ := cm[key].(string); return value }
	headerTurn := gjson.Parse(headers.Get("X-Codex-Turn-Metadata"))
	bodyTurn := gjson.Parse(str("x-codex-turn-metadata"))
	originalBodySession := str("session_id")
	originalSession := first(headers.Get("Session-Id"), headers.Get("Session_id"), originalBodySession, bodyTurn.Get("session_id").String(), headerTurn.Get("session_id").String())
	originalThread := first(str("thread_id"), headers.Get("Thread-Id"), headers.Get("Thread_id"), bodyTurn.Get("thread_id").String(), headerTurn.Get("thread_id").String(), originalSession)
	namespace := uuid.MustParse(f.Namespace)
	derive := func(kind, value string) string {
		// Length-delimited fields prevent ambiguous concatenation; per-customer
		// device identity keeps two clients with the same session string isolated.
		key, _ := json.Marshal([]string{kind, clientID, value})
		return uuid.NewSHA1(namespace, key).String()
	}
	fields := map[string]any{"installation_id": f.InstallationID}
	cm["x-codex-installation-id"] = f.InstallationID
	if _, exists := cm["installation_id"]; exists {
		cm["installation_id"] = f.InstallationID
	}
	nextHeaders := headers.Clone()
	applyCodexFingerprintClientHeaders(nextHeaders, f)
	nextHeaders.Set("X-Codex-Installation-Id", f.InstallationID)
	if f.Mode != "device" {
		thread := derive("thread", originalThread)
		if f.Mode == "full" {
			thread = f.SessionID
		}
		fields["session_id"], fields["thread_id"] = f.SessionID, thread
		cm["session_id"], cm["thread_id"] = f.SessionID, thread
		nextHeaders.Set("Session-Id", f.SessionID)
		nextHeaders.Set("Session_id", f.SessionID)
		nextHeaders.Set("Thread-Id", thread)
		if nextHeaders.Get("Thread_id") != "" {
			nextHeaders.Set("Thread_id", thread)
		}
		// A window is independently namespaced; never manufacture thread + ':0'.
		window := first(headers.Get("X-Codex-Window-Id"), str("x-codex-window-id"), bodyTurn.Get("window_id").String(), headerTurn.Get("window_id").String())
		if window != "" {
			window = derive("window", window)
			if f.Mode == "full" {
				window = uuid.NewSHA1(namespace, []byte("window")).String()
			}
			fields["window_id"] = window
			cm["x-codex-window-id"] = window
			nextHeaders.Set("X-Codex-Window-Id", window)
		}
		// Only remap a provable default cache key; custom cache keys remain untouched.
		cache := gjson.GetBytes(body, "prompt_cache_key")
		if cache.Type == gjson.String && cache.Str != "" && (cache.Str == originalSession || cache.Str == originalThread || cache.Str == originalBodySession) {
			updated, err := sjson.SetBytes(body, "prompt_cache_key", thread)
			if err != nil {
				return body
			}
			body = updated
		}
	}
	rewriteEmbedded := func(raw string) string {
		metadata := map[string]any{}
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.UseNumber()
		if decoder.Decode(&metadata) != nil || metadata == nil {
			metadata = map[string]any{}
		}
		for key, value := range fields {
			metadata[key] = value
		}
		encoded, _ := json.Marshal(metadata)
		return string(encoded)
	}
	if raw := nextHeaders.Get("X-Codex-Turn-Metadata"); raw != "" {
		nextHeaders.Set("X-Codex-Turn-Metadata", rewriteEmbedded(raw))
	}
	if raw, ok := cm["x-codex-turn-metadata"].(string); ok && raw != "" {
		cm["x-codex-turn-metadata"] = rewriteEmbedded(raw)
	}
	if len(body) > 0 {
		raw, _ := json.Marshal(cm)
		updated, err := sjson.SetRawBytes(body, "client_metadata", raw)
		if err != nil {
			return body
		}
		body = updated
	}
	for key := range headers {
		delete(headers, key)
	}
	for key, values := range nextHeaders {
		headers[key] = values
	}
	return body
}

package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/tidwall/gjson"
)

func fingerprintTestLease(mode string) *CodexTokenLease {
	return &CodexTokenLease{AccountId: 7, AccessToken: "test-token", Fingerprint: &CodexFingerprint{
		Mode: mode, InstallationID: "acaf21bb-4b92-4b69-857a-ec2a2e754900", SessionID: "12f0e817-5e56-4620-a305-b4017235897c", Namespace: "6dc837d0-f22c-4275-87c9-645cc4b32cd8",
	}}
}

func TestCodexFingerprintModesAndIsolation(t *testing.T) {
	raw := []byte(`{"input":[{"content":"leave intact"}],"prompt_cache_key":"client-session","client_metadata":{"session_id":"client-session","thread_id":"client-thread","turn_id":"original-turn","x-codex-window-id":"original-window","x-codex-turn-metadata":"{\"turn_id\":\"original-turn\",\"turn_started_at_unix_ms\":42,\"sandbox\":true}"}}`)
	for _, mode := range []string{"off", "device", "session", "full", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			lease := fingerprintTestLease(mode)
			headers := http.Header{}
			headers.Set("Session-Id", "client-session")
			headers.Set("Thread-Id", "client-thread")
			headers.Set("X-Codex-Turn-Metadata", `{"turn_id":"original-turn","turn_started_at_unix_ms":42,"sandbox":true}`)
			before := headers.Clone()
			result := applyCodexFingerprint(raw, headers, lease, "client-a")
			if mode == "off" || mode == "unknown" {
				if !bytes.Equal(raw, result) || !reflect.DeepEqual(before, headers) {
					t.Fatal("off must be exact passthrough")
				}
				return
			}
			if headers.Get("X-Codex-Installation-Id") != lease.Fingerprint.InstallationID {
				t.Fatal("missing installation identity")
			}
			if gjson.GetBytes(result, "client_metadata.turn_id").Str != "original-turn" {
				t.Fatal("turn changed")
			}
			embedded := gjson.Parse(gjson.GetBytes(result, "client_metadata.x-codex-turn-metadata").Str)
			if embedded.Get("turn_started_at_unix_ms").Int() != 42 || !embedded.Get("sandbox").Bool() {
				t.Fatal("metadata lost")
			}
			if mode == "device" {
				if headers.Get("Session-Id") != "client-session" || gjson.GetBytes(result, "prompt_cache_key").Str != "client-session" {
					t.Fatal("device mode changed session")
				}
				return
			}
			if headers.Get("Session-Id") != gjson.GetBytes(result, "client_metadata.session_id").Str || headers.Get("Thread-Id") != gjson.GetBytes(result, "client_metadata.thread_id").Str {
				t.Fatal("body/header mismatch")
			}
			if gjson.GetBytes(result, "prompt_cache_key").Str != headers.Get("Thread-Id") {
				t.Fatal("default cache not aligned with thread")
			}
			otherHeaders := before.Clone()
			other := applyCodexFingerprint(raw, otherHeaders, lease, "client-b")
			sameThread := gjson.GetBytes(result, "client_metadata.thread_id").Str == gjson.GetBytes(other, "client_metadata.thread_id").Str
			if sameThread != (mode == "full") {
				t.Fatal("incorrect cross-client isolation")
			}
			if !bytes.Equal(result, applyCodexFingerprint(raw, before.Clone(), lease, "client-a")) {
				t.Fatal("retry must be stable")
			}
		})
	}
}

func TestCodexFingerprintMalformedRelayAndCustomCache(t *testing.T) {
	for _, raw := range []string{"{", "[]", "null", `{"type":"response.cancel"}`} {
		h := http.Header{}
		if string(applyCodexFingerprint([]byte(raw), h, fingerprintTestLease("full"), "a")) != raw || len(h) != 0 {
			t.Fatalf("changed non-request %s", raw)
		}
	}
	lease := fingerprintTestLease("session")
	lease.Mode, lease.Relay = "relay", &CodexLeaseRelay{}
	raw := []byte(`{"client_metadata":null}`)
	if !bytes.Equal(applyCodexFingerprint(raw, http.Header{}, lease, "a"), raw) {
		t.Fatal("relay changed")
	}
	lease.Mode = ""
	custom := applyCodexFingerprint([]byte(`{"prompt_cache_key":"explicit-cache"}`), http.Header{}, lease, "a")
	if gjson.GetBytes(custom, "prompt_cache_key").Str != "explicit-cache" {
		t.Fatal("custom cache changed")
	}
}

func TestCodexFingerprintHTTPAndCompact(t *testing.T) {
	lease := fingerprintTestLease("session")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !r.URL.IsAbs() {
			t.Error("request bypassed bound forward proxy")
		}
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Codex-Installation-Id") != lease.Fingerprint.InstallationID || gjson.GetBytes(body, "client_metadata.session_id").Str != lease.Fingerprint.SessionID {
			t.Error("fingerprint did not reach upstream")
		}
		if r.ContentLength != int64(len(body)) {
			t.Error("stale content length")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()
	lease.ProxyURL = upstream.URL
	proxy := &CodexProxy{upstreamBase: "http://codex-upstream.invalid", leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
		return lease, nil
	}, reportResult: func(string, string, ReportDetails, string, *CodexTokenLease) {}}
	for _, path := range []string{"/v1/responses", "/backend-api/codex/responses/compact"} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"model":"gpt-5-codex","input":"hi"}`))
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, r, "card", "device", "direct")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
}

func TestCodexFingerprintAccountSwitch(t *testing.T) {
	raw := []byte(`{"client_metadata":{"session_id":"original"},"prompt_cache_key":"original"}`)
	a, b := fingerprintTestLease("session"), fingerprintTestLease("session")
	b.Fingerprint.Namespace = uuid.NewString()
	b.Fingerprint.InstallationID = uuid.NewString()
	first := applyCodexFingerprint(raw, http.Header{}, a, "client")
	second := applyCodexFingerprint(raw, http.Header{}, b, "client")
	if bytes.Equal(first, second) || gjson.GetBytes(first, "prompt_cache_key").Str == gjson.GetBytes(second, "prompt_cache_key").Str {
		t.Fatal("account identities mixed")
	}
	if !bytes.Equal(raw, applyCodexFingerprint(raw, http.Header{}, fingerprintTestLease("off"), "client")) {
		t.Fatal("off account inherited identity")
	}
}

func TestCodexFingerprintWebSocketEveryTurn(t *testing.T) {
	lease := fingerprintTestLease("session")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Codex-Installation-Id") != lease.Fingerprint.InstallationID {
			t.Error("WS handshake identity missing")
		}
		if r.Header.Get("User-Agent") != codexDefaultUserAgent || r.Header.Get("Version") != "0.154.0" {
			t.Error("WS client profile mismatch")
		}
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	var proxyHits atomic.Int32
	exit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != strings.TrimPrefix(upstream.URL, "http://") {
			t.Error("unexpected proxy destination")
			http.Error(w, "bad destination", 400)
			return
		}
		target, err := net.DialTimeout("tcp", r.Host, time.Second)
		if err != nil {
			t.Error(err)
			http.Error(w, "dial failed", 502)
			return
		}
		defer target.Close()
		client, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer client.Close()
		proxyHits.Add(1)
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		go func() { _, _ = io.Copy(target, buffered); _ = target.Close() }()
		_, _ = io.Copy(client, target)
	}))
	defer exit.Close()
	lease.ProxyURL = exit.URL
	proxy := &CodexProxy{upstreamBase: upstream.URL, leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
		return lease, nil
	}, reportResult: func(string, string, ReportDetails, string, *CodexTokenLease) {}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r, "card", "client-a", "direct")
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/backend-api/codex/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	var thread string
	for _, turn := range []string{"first", "second"} {
		raw := []byte(`{"type":"response.create","client_metadata":{"session_id":"original-session","turn_id":"` + turn + `"}}`)
		if err := conn.WriteMessage(websocket.TextMessage, raw); err != nil {
			t.Fatal(err)
		}
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if proxyHits.Load() != 1 {
			t.Fatal("WS bypassed account proxy")
		}
		if gjson.GetBytes(data, "client_metadata.session_id").Str != lease.Fingerprint.SessionID || gjson.GetBytes(data, "client_metadata.turn_id").Str != turn {
			t.Fatal("WS identity/turn mismatch")
		}
		current := gjson.GetBytes(data, "client_metadata.thread_id").Str
		if thread != "" && current != thread {
			t.Fatal("thread changed between WS turns")
		}
		thread = current
		httpHeaders := http.Header{}
		equivalent := applyCodexFingerprint(raw, httpHeaders, lease, "client-a")
		if gjson.GetBytes(equivalent, "client_metadata.thread_id").Str != current {
			t.Fatal("HTTP/WS mismatch")
		}
	}
}

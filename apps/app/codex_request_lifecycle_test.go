package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestCodexRequestBoundedRetry(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "original" || r.Header.Get("Authorization") != "Bearer test" || r.Header.Get("Session-Id") != "session-a" {
			t.Error("retry changed request identity or body")
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"error":{"code":"server_is_overloaded"}}`)
	}))
	defer server.Close()
	req, _ := http.NewRequest("POST", server.URL, strings.NewReader("original"))
	req.Header.Set("Authorization", "Bearer test")
	req.Header.Set("Session-Id", "session-a")
	resp, err := doCodexRequest(req, server.Client().Do)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if calls.Load() != 2 || resp.StatusCode != 503 || !strings.Contains(string(body), "server_is_overloaded") {
		t.Fatalf("calls=%d status=%d body=%s", calls.Load(), resp.StatusCode, body)
	}
}

func TestCodexRequestNeverReplaysUnsafeResponses(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		status                        int
		contentType, body, retryAfter string
	}{
		{"auth", 401, "application/json", `{"error":{"code":"server_is_overloaded"}}`, ""},
		{"quota", 429, "application/json", `{"error":{"code":"quota_exceeded"}}`, ""},
		{"access", 503, "application/json", `{"error":{"code":"access_denied"}}`, ""},
		{"unknown", 503, "application/json", `{"error":{"message":"at capacity"}}`, ""},
		{"stream", 200, "text/event-stream", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_is_overloaded\"}}}\n\n", ""},
		{"output", 503, "application/json", `{"error":{"code":"slow_down"},"output":[{"type":"function_call"}]}`, ""},
		{"usage", 503, "application/json", `{"error":{"code":"slow_down"},"usage":{}}`, ""},
		{"long wait", 503, "application/json", `{"error":{"code":"slow_down"}}`, "60"},
		{"large body", 503, "application/json", strings.Repeat(" ", 65537), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			req, _ := http.NewRequest("POST", "http://test", strings.NewReader("body"))
			resp, err := doCodexRequest(req, func(*http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": {tc.contentType}, "Retry-After": {tc.retryAfter}}, ContentLength: int64(len(tc.body)), Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if calls != 1 || string(body) != tc.body {
				t.Fatalf("calls=%d body changed=%v", calls, string(body) != tc.body)
			}
		})
	}
}

func TestCodexRetryCancellationAndTransportError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://test", strings.NewReader("body"))
	var calls atomic.Int32
	done := make(chan error, 1)
	go func() {
		_, err := doCodexRequest(req, func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			body := `{"error":{"code":"slow_down"}}`
			return &http.Response{StatusCode: 503, Header: http.Header{"Content-Type": {"application/json"}}, ContentLength: int64(len(body)), Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		done <- err
	}()
	time.AfterFunc(50*time.Millisecond, cancel)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
			t.Fatalf("err=%v calls=%d", err, calls.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt backoff")
	}
	transportErr := errors.New("connection lost after sending request")
	calls.Store(0)
	req, _ = http.NewRequest("POST", "http://test", strings.NewReader("body"))
	_, err := doCodexRequest(req, func(*http.Request) (*http.Response, error) { calls.Add(1); return nil, transportErr })
	if err != transportErr || calls.Load() != 1 {
		t.Fatal("ambiguous request was replayed")
	}
}

func TestCodexHTTPClientCancellationReachesUpstream(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer upstream.Close()
	proxy := &CodexProxy{upstreamBase: upstream.URL,
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: "test", AccountId: 1}, nil
		},
		reportProblem: func(string, string, ReportDetails, string, *CodexTokenLease) {},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex"}`)).WithContext(ctx)
	done := make(chan struct{})
	go func() { defer close(done); proxy.ServeHTTP(httptest.NewRecorder(), req, "card", "device", "direct") }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never started")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not cancelled")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not finish")
	}
}

func TestCodexWebSocketFailureAndClientUsageIsolation(t *testing.T) {
	const failed = `{"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}`
	upstreamClosed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		defer close(upstreamClosed)
		_, _, err = c.ReadMessage()
		if err != nil {
			return
		}
		_, _, err = c.ReadMessage()
		if err != nil {
			return
		}
		_ = c.WriteMessage(websocket.TextMessage, []byte(failed))
		_, _, _ = c.ReadMessage()
	}))
	defer upstream.Close()
	reported := make(chan ReportDetails, 1)
	p := &CodexProxy{upstreamBase: upstream.URL,
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: "test", AccountId: 1}, nil
		},
		reportProblem: func(_ string, _ string, d ReportDetails, _ string, _ *CodexTokenLease) { reported <- d },
		reportResult: func(string, string, ReportDetails, string, *CodexTokenLease) {
			t.Error("failed connection counted as success")
		},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { p.ServeHTTP(w, r, "card", "device", "direct") }))
	defer server.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/backend-api/codex/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"gpt-5-codex","usage":{"total_tokens":99999}}`))
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"gpt-5-codex","usage":{"total_tokens":99999}}`))
	_, body, err := c.ReadMessage()
	if err != nil || string(body) != failed {
		t.Fatalf("error changed: %s %v", body, err)
	}
	_ = c.Close()
	select {
	case d := <-reported:
		if d.RawTotalTokens != 0 || !strings.Contains(d.Reason, "class=capacity") {
			t.Fatalf("bad report: %+v", d)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("missing failure report")
	}
	select {
	case <-upstreamClosed:
	case <-time.After(time.Second):
		t.Fatal("upstream connection leaked")
	}
}

func TestCodexErrorClassificationAcrossTransports(t *testing.T) {
	for _, code := range []string{"server_is_overloaded", "slow_down", "access_denied", "rate_limit_exceeded", "quota_exceeded"} {
		var httpError, sse, ws codexStreamDiagnostic
		httpError.observe([]byte(`{"error":{"code":"` + code + `"}}`))
		sse.observe([]byte(`data: {"type":"response.failed","response":{"error":{"code":"` + code + `"}}}`))
		ws.observe([]byte(`{"type":"error","code":"` + code + `"}`))
		if httpError.Code != code || sse.Code != code || ws.Code != code {
			t.Fatalf("inconsistent classification for %s", code)
		}
	}
}

func TestCodexRetryAfterBounds(t *testing.T) {
	now := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		delay time.Duration
		ok    bool
	}{
		{"", time.Second, true}, {"0", time.Second, true}, {"3", 3 * time.Second, true},
		{"600", 0, false}, {"-1", 0, false}, {"invalid", 0, false},
		{now.Add(4 * time.Second).Format(http.TimeFormat), 4 * time.Second, true},
		{now.Add(time.Hour).Format(http.TimeFormat), time.Hour, false},
	} {
		delay, ok := codexRetryDelay(tc.value, now)
		if ok != tc.ok || delay != tc.delay {
			t.Fatalf("%q: %v %v", tc.value, delay, ok)
		}
	}
}

type codexBrokenErrorBody struct{ closed bool }

func (b *codexBrokenErrorBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (b *codexBrokenErrorBody) Close() error             { b.closed = true; return nil }

func TestCodexTruncatedRejectionDoesNotRetryOrHideReadError(t *testing.T) {
	body := &codexBrokenErrorBody{}
	req, _ := http.NewRequest("POST", "http://test", strings.NewReader("body"))
	calls := 0
	resp, err := doCodexRequest(req, func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Header: http.Header{"Content-Type": {"application/json"}}, ContentLength: 50, Body: body}, nil
	})
	if resp != nil || !errors.Is(err, io.ErrUnexpectedEOF) || calls != 1 || !body.closed {
		t.Fatalf("resp=%v err=%v calls=%d closed=%v", resp, err, calls, body.closed)
	}
}

func TestCodexSSEFailureIsReportedOnceWithoutReplay(t *testing.T) {
	const body = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_is_overloaded\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":2,\"total_tokens\":12}}}\n\n"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, body)
	}))
	defer upstream.Close()
	reports := 0
	p := &CodexProxy{upstreamBase: upstream.URL,
		leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
			return &CodexTokenLease{AccessToken: "test", AccountId: 1}, nil
		},
		reportProblem: func(_ string, _ string, d ReportDetails, _ string, _ *CodexTokenLease) {
			reports++
			if d.StatusCode != 502 || d.RawTotalTokens != 12 || !strings.Contains(d.Reason, "class=capacity") {
				t.Fatalf("bad failure report: %+v", d)
			}
		},
		reportResult: func(string, string, ReportDetails, string, *CodexTokenLease) {
			t.Error("failed SSE counted as success")
		},
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-5-codex"}`)), "card", "device", "direct")
	if reports != 1 || calls.Load() != 1 || w.Body.String() != body || w.Code != 200 {
		t.Fatalf("reports=%d calls=%d status=%d body=%q", reports, calls.Load(), w.Code, w.Body.String())
	}
}

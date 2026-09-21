package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Model a bound endpoint whose advertised HTTP protocol returns 400, while
// SOCKS5 on the SAME endpoint works. No takeover/preflight cache is populated.
func TestCodexProtocolColdStartRecovery(t *testing.T) {
	var generated, rejected atomic.Int32
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { generated.Add(1); io.WriteString(w, "ok") }))
	defer up.Close()
	target := strings.TrimPrefix(up.URL, "https://")
	socks := strings.TrimPrefix(codexTestSocksProxy(t, target, target), "socks5://")
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.SetDeadline(time.Now().Add(3 * time.Second))
				var first [1]byte
				if _, err := io.ReadFull(c, first[:]); err != nil {
					return
				}
				if first[0] != 5 {
					rejected.Add(1)
					io.WriteString(c, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
					return
				}
				s, err := net.Dial("tcp", socks)
				if err != nil {
					return
				}
				defer s.Close()
				s.Write(first[:])
				go func() { io.Copy(s, c); s.Close() }()
				io.Copy(c, s)
			}()
		}
	}()
	lease := &CodexTokenLease{EgressInfo: EgressInfo{ProxyURL: "http://" + l.Addr().String(), EgressRequired: true}}
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest("POST", up.URL, strings.NewReader("one generation"))
		req.Close = true
		resp, err := doCodexUpstream(lease, "direct", nil, req, func(string) *http.Client { return up.Client() })
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != "ok" {
			t.Fatal(string(b))
		}
	}
	if rejected.Load() != 1 || generated.Load() != 2 {
		t.Fatalf("HTTP attempts=%d generated=%d", rejected.Load(), generated.Load())
	}
	// WebSocket uses the same protocol-aware tunnel, also without preflight.
	ws, err := newCodexWSDialer(lease, "direct")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, err := ws.NetDialContext(ctx, "tcp", target)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if rejected.Load() != 1 {
		t.Fatal("WebSocket did not reuse protocol discovery")
	}

	var outerCalls atomic.Int32
	outer := codexTestConnectProxy(t, "account.invalid:1080", l.Addr().String(), &outerCalls)
	chained := &CodexTokenLease{EgressInfo: EgressInfo{ProxyURL: "http://account.invalid:1080", EgressRequired: true}}
	req, _ := http.NewRequest("POST", up.URL, strings.NewReader("one chained generation"))
	req.Close = true
	resp, err := doCodexUpstream(chained, outer.URL, nil, req, func(string) *http.Client { return up.Client() })
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if generated.Load() != 3 || rejected.Load() != 2 || outerCalls.Load() != 2 {
		t.Fatalf("chained discovery: generated=%d rejected=%d local hops=%d", generated.Load(), rejected.Load(), outerCalls.Load())
	}
}
func TestCodexProtocolDenialAndCancellation(t *testing.T) {
	for _, status := range []int{403, 407} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(status) }))
			defer proxy.Close()
			dialer, err := codexBoundProxyDialer(proxy.URL, "direct")
			if err != nil {
				t.Fatal(err)
			}
			if c, err := dialer.DialContext(context.Background(), "tcp", "example.invalid:443"); err == nil {
				c.Close()
				t.Fatal("denial accepted")
			}
			if calls.Load() != 1 {
				t.Fatal("denial retried")
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := dialer.DialContext(ctx, "tcp", "example.invalid:443"); err == nil {
				t.Fatal("cancellation ignored")
			}
			if calls.Load() != 1 {
				t.Fatal("canceled request dialed")
			}
		})
	}
}
func TestCodexTransportCoolingMessage(t *testing.T) {
	err := parseCodexSessionCooling(503, []byte(`{"code":"codex_session_cooling","reason":"transport","retryAfterMs":1501}`))
	w := httptest.NewRecorder()
	if !writeCodexSessionCooling(w, err) || !strings.Contains(w.Body.String(), "代理或网络连接失败") || w.Header().Get("Retry-After") != "2" {
		t.Fatal(w.Body.String())
	}
	old := parseCodexSessionCooling(503, []byte(`{"code":"codex_session_cooling","retryAfterMs":1000}`))
	if strings.Contains(old.Error(), "模型") {
		t.Fatal("old server inferred model capacity")
	}
}

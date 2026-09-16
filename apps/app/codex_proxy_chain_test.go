package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func codexTestSocksProxy(t *testing.T, expected, destination string) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.SetDeadline(time.Now().Add(5 * time.Second))
				var header [2]byte
				if _, err := io.ReadFull(c, header[:]); err != nil {
					return
				}
				methods := make([]byte, int(header[1]))
				if _, err := io.ReadFull(c, methods); err != nil {
					return
				}
				c.Write([]byte{5, 0})
				var request [4]byte
				if _, err := io.ReadFull(c, request[:]); err != nil {
					return
				}
				var host string
				switch request[3] {
				case 1:
					ip := make([]byte, 4)
					if _, err := io.ReadFull(c, ip); err != nil {
						return
					}
					host = net.IP(ip).String()
				case 3:
					var size [1]byte
					if _, err := io.ReadFull(c, size[:]); err != nil {
						return
					}
					name := make([]byte, int(size[0]))
					if _, err := io.ReadFull(c, name); err != nil {
						return
					}
					host = string(name)
				default:
					return
				}
				var port [2]byte
				if _, err := io.ReadFull(c, port[:]); err != nil {
					return
				}
				if net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port[:])))) != expected {
					return
				}
				up, err := net.DialTimeout("tcp", destination, time.Second)
				if err != nil {
					return
				}
				defer up.Close()
				c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				go func() { io.Copy(up, c); up.Close() }()
				io.Copy(c, up)
			}()
		}
	}()
	return "socks5://" + l.Addr().String()
}

func TestCodexBoundEgressSOCKSChain(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	defer up.Close()
	target := strings.TrimPrefix(up.URL, "http://")
	inner := codexTestSocksProxy(t, target, target)
	var count atomic.Int32
	outer := codexTestConnectProxy(t, "account.invalid:1080", strings.TrimPrefix(inner, "socks5://"), &count)
	getSystemProxy()
	previous := systemProxyURL
	systemProxyURL = outer.URL
	defer func() { systemProxyURL = previous }()
	if err := codexEgressReachable(target, "socks5://account.invalid:1080"); err != nil {
		t.Fatal(err)
	}
	for _, local := range []string{outer.URL, codexTestSocksProxy(t, "account.invalid:1080", strings.TrimPrefix(inner, "socks5://"))} {
		lease := &CodexTokenLease{EgressInfo: EgressInfo{ProxyURL: "socks5://account.invalid:1080", EgressRequired: true}}
		req, _ := http.NewRequest("GET", up.URL, nil)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		req = req.WithContext(ctx)
		req.Close = true
		resp, err := doCodexUpstream(lease, local, nil, req, createHttpClient)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		if err != nil || string(data) != "ok" {
			t.Fatalf("SOCKS chain: %s %v", data, err)
		}
	}
}

func TestCodexBoundEgressGateMessage(t *testing.T) {
	err := enforceEgressGateWith("codex", Config{}, func(string, Config) (EgressInfo, error) {
		return EgressInfo{ProxyURL: "http://account.invalid:8080", EgressRequired: true}, nil
	}, func(string, string) error { return errors.New("connection reset") })
	if err == nil || !strings.Contains(err.Error(), "系统代理") || strings.Contains(err.Error(), "开启【TUN") {
		t.Fatalf("unexpected guidance: %v", err)
	}
}

func TestCodexBoundEgressCONNECTCancellation(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, e := l.Accept()
		if e == nil {
			accepted <- c
		}
	}()
	d, err := codexBoundProxyDialer("http://"+l.Addr().String(), "direct")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		c, e := d.DialContext(ctx, "tcp", "upstream.invalid:443")
		if c != nil {
			c.Close()
		}
		done <- e
	}()
	select {
	case c := <-accepted:
		defer c.Close()
	case <-time.After(time.Second):
		t.Fatal("not connected")
	}
	cancel()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancellation succeeded unexpectedly")
		}
	case <-time.After(time.Second):
		t.Fatal("CONNECT ignored cancellation")
	}
}

// Only the outer proxy can resolve account.invalid, so bypassing either hop
// cannot accidentally pass these tests.
func codexTestConnectProxy(t *testing.T, expected, destination string, count *atomic.Int32) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != expected {
			http.Error(w, "unexpected target", 400)
			return
		}
		count.Add(1)
		up, err := net.DialTimeout("tcp", destination, time.Second)
		if err != nil {
			http.Error(w, "unreachable", 502)
			return
		}
		down, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			up.Close()
			return
		}
		rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		rw.Flush()
		go func() { defer up.Close(); defer down.Close(); io.Copy(up, rw) }()
		go func() { defer up.Close(); defer down.Close(); io.Copy(down, up) }()
	}))
	t.Cleanup(s.Close)
	return s
}

func TestCodexBoundEgressLocalProxyChain(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if websocket.IsWebSocketUpgrade(r) {
			conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			kind, data, err := conn.ReadMessage()
			if err == nil {
				conn.WriteMessage(kind, data)
			}
			return
		}
		io.WriteString(w, "ok")
	}))
	defer up.Close()
	var innerCalls, outerCalls atomic.Int32
	target := strings.TrimPrefix(up.URL, "https://")
	inner := codexTestConnectProxy(t, target, target, &innerCalls)
	outer := codexTestConnectProxy(t, "account.invalid:8080", strings.TrimPrefix(inner.URL, "http://"), &outerCalls)
	bound := "http://account.invalid:8080"
	lease := &CodexTokenLease{EgressInfo: EgressInfo{ProxyURL: bound, EgressRequired: true}}
	// Exercise the same tunnel used by uTLS and takeover preflight.
	dialer, err := codexBoundProxyDialer(bound, outer.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp", target)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	ws, err := newCodexWSDialer(lease, outer.URL)
	if err != nil {
		t.Fatal(err)
	}
	ws.TLSClientConfig = up.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	c, _, err := ws.DialContext(ctx, "wss://"+target, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte("hello"))
	_, data, err := c.ReadMessage()
	if err != nil || string(data) != "hello" {
		t.Fatalf("echo: %s %v", data, err)
	}
	for _, factory := range []func(string) *http.Client{createHttpClient, createCodexStreamingHttpClient} {
		clientFactory := func(endpoint string) *http.Client {
			client := factory(endpoint)
			switch rt := client.Transport.(type) {
			case *http.Transport:
				rt.TLSClientConfig = up.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
			case *codexFallbackRoundTripper:
				rt.fallback.(*http.Transport).TLSClientConfig = up.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
			}
			return client
		}
		req, _ := http.NewRequestWithContext(ctx, "GET", up.URL, nil)
		req.Close = true
		resp, err := doCodexUpstream(lease, outer.URL, nil, req, clientFactory)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || string(data) != "ok" {
			t.Fatalf("HTTP: %s %v", data, err)
		}
	}
	if innerCalls.Load() != 4 || outerCalls.Load() != 4 {
		t.Fatalf("hops: %d %d", innerCalls.Load(), outerCalls.Load())
	}
	// A dead local hop must fail, even though the account proxy is reachable.
	before := innerCalls.Load()
	dialer, err = codexBoundProxyDialer(inner.URL, "http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := dialer.DialContext(ctx, "tcp", target); err == nil {
		conn.Close()
		t.Fatal("unexpected fallback")
	}
	if innerCalls.Load() != before {
		t.Fatal("bypassed local proxy")
	}
}

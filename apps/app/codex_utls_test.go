package main

import (
	"bufio"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/net/proxy"
)

func TestIsCodexUtlsProtectedHost(t *testing.T) {
	for _, h := range []string{"chatgpt.com", "ChatGPT.com", "www.chatgpt.com"} {
		if !isCodexUtlsProtectedHost(h) {
			t.Errorf("%s should be protected", h)
		}
	}
	for _, h := range []string{"example.com", "api.openai.com", "relay.foo.bar"} {
		if isCodexUtlsProtectedHost(h) {
			t.Errorf("%s should NOT be protected", h)
		}
	}
}

func TestBuildCodexProxyDialer(t *testing.T) {
	if d := buildCodexProxyDialer(""); d != proxy.Direct {
		t.Errorf("empty proxy should be Direct")
	}
	if d := buildCodexProxyDialer("direct"); d != proxy.Direct {
		t.Errorf("'direct' should be Direct")
	}
	if d := buildCodexProxyDialer("http://127.0.0.1:7890"); d == proxy.Direct {
		t.Errorf("http proxy should not be Direct")
	} else if _, ok := d.(*codexHTTPConnectDialer); !ok {
		t.Errorf("http proxy should yield codexHTTPConnectDialer, got %T", d)
	}
	if d := buildCodexProxyDialer("socks5://127.0.0.1:1080"); d == proxy.Direct {
		t.Errorf("socks5 proxy should not be Direct")
	}
}

func TestResolveCodexEffectiveProxy(t *testing.T) {
	if got := resolveCodexEffectiveProxy("http://1.2.3.4:8080"); got != "http://1.2.3.4:8080" {
		t.Errorf("explicit proxy not preserved: %q", got)
	}
	if got := resolveCodexEffectiveProxy("direct"); got != "" {
		t.Errorf("'direct' should resolve to empty, got %q", got)
	}
}

// recordingRT 记录是否被调用。
type recordingRT struct{ called bool }

func (r *recordingRT) RoundTrip(*http.Request) (*http.Response, error) {
	r.called = true
	return nil, errFakeRT
}

var errFakeRT = &net.OpError{Op: "fake"}

func TestCodexFallbackRoundTripperRouting(t *testing.T) {
	cases := []struct {
		url      string
		wantUtls bool
	}{
		{"https://chatgpt.com/backend-api/codex/responses", true},
		{"https://www.chatgpt.com/x", true},
		{"https://example.com/responses", false},  // 非受保护 → fallback
		{"http://chatgpt.com/responses", false},   // 非 https → fallback
	}
	for _, c := range cases {
		utlsRT := &recordingRT{}
		fb := &recordingRT{}
		f := &codexFallbackRoundTripper{utls: utlsRT, fallback: fb}
		req, _ := http.NewRequest(http.MethodPost, c.url, nil)
		_, _ = f.RoundTrip(req)
		if c.wantUtls && !utlsRT.called {
			t.Errorf("%s: expected uTLS path", c.url)
		}
		if !c.wantUtls && !fb.called {
			t.Errorf("%s: expected fallback path", c.url)
		}
		if c.wantUtls && fb.called {
			t.Errorf("%s: fallback wrongly called", c.url)
		}
	}
}

// TestCodexHTTPConnectDialer 用一个假的 HTTP 代理验证 CONNECT 隧道建立。
func TestCodexHTTPConnectDialer(t *testing.T) {
	run := func(status string, wantErr bool) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer ln.Close()
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			br := bufio.NewReader(conn)
			// 读到空行(请求头结束)。
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimSpace(line) == "" {
					break
				}
			}
			_, _ = conn.Write([]byte("HTTP/1.1 " + status + "\r\n\r\n"))
		}()

		d := &codexHTTPConnectDialer{
			proxyURL: &url.URL{Scheme: "http", Host: ln.Addr().String()},
			forward:  &net.Dialer{},
		}
		conn, err := d.Dial("tcp", "chatgpt.com:443")
		if wantErr {
			if err == nil {
				conn.Close()
				t.Errorf("status %q: expected error", status)
			}
			return
		}
		if err != nil {
			t.Errorf("status %q: unexpected error: %v", status, err)
			return
		}
		conn.Close()
	}
	run("200 Connection established", false)
	run("403 Forbidden", true)
}

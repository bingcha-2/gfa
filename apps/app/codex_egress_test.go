package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCodexBoundEgressRejectsMissingInvalidProxy(t *testing.T) {
	for _, raw := range []string{"", "direct", "ftp://exit:80", "socks4://exit:1080", "http://exit:0", "http://exit:65536", "http://exit/path", "http://exit?secret=1"} {
		t.Run(raw, func(t *testing.T) {
			lease := fingerprintTestLease("device")
			lease.ProxyURL = raw
			lease.Fingerprint.InstallationID = "invalid"
			seen := map[string][]byte{}
			_, err := doCodexUpstream(lease, "http://local:8080", nil, mustReq(t, nil), clientFactory(nil, seen))
			if err == nil || len(seen) != 0 {
				t.Fatal("invalid bound egress must fail before any request")
			}
			if _, err := newCodexWSDialer(lease, "http://local:8080"); err == nil {
				t.Fatal("WS accepted invalid bound proxy")
			}
		})
	}
}

func TestCodexBoundEgressFailureNeverFallsBack(t *testing.T) {
	for _, mode := range []string{"device", "session", "full", "off"} {
		lease := fingerprintTestLease(mode)
		lease.ProxyURL = "http://exit:8080"
		seen := map[string][]byte{}
		resp, err := doCodexUpstream(lease, "http://local:8080", []byte("body"), mustReq(t, []byte("body")), clientFactory(map[string]bool{lease.ProxyURL: true}, seen))
		if mode == "off" {
			if err != nil || len(seen) != 2 {
				t.Fatal("off lost existing optional fallback")
			}
			resp.Body.Close()
		} else if err == nil || len(seen) != 1 || string(seen[lease.ProxyURL]) != "body" {
			t.Fatal("bound failure fell back")
		}
	}
	for raw, want := range map[string]string{"http://exit": "http://exit:80", "https://exit": "https://exit:443", "socks5://exit": "socks5://exit:1080", "socks5h://exit": "socks5h://exit:1080"} {
		lease := fingerprintTestLease("device")
		lease.ProxyURL = raw
		got, err := resolveCodexLeaseProxy(lease, "direct")
		if err != nil || got != want {
			t.Fatalf("%s => %s: %v", raw, got, err)
		}
	}
}

func TestCodexFingerprintClientProfile(t *testing.T) {
	for _, mode := range []string{"device", "session", "full"} {
		lease := fingerprintTestLease(mode)
		lease.Fingerprint.Client = &CodexFingerprintClient{UserAgent: "stable-agent", Originator: "stable-client", Version: "stable-version"}
		h := http.Header{}
		for _, key := range []string{"User-Agent", "Originator", "Version", "Sec-CH-UA-Platform", "X-Stainless-OS", "X-Forwarded-For", "Forwarded", "X-Real-IP"} {
			h.Set(key, "local-value")
		}
		h.Set("OpenAI-Beta", "responses=experimental")
		h.Set("Authorization", "Bearer original")
		h.Set("X-Codex-Turn-State", "opaque")
		applyCodexFingerprint([]byte(`{"input":"hi"}`), h, lease, "device")
		if h.Get("User-Agent") != "stable-agent" || h.Get("Originator") != "stable-client" || h.Get("Version") != "stable-version" {
			t.Fatal("profile mismatch")
		}
		for _, key := range []string{"Sec-CH-UA-Platform", "X-Stainless-OS", "X-Forwarded-For", "Forwarded", "X-Real-IP"} {
			if h.Get(key) != "" {
				t.Fatalf("local header retained: %s", key)
			}
		}
		if h.Get("OpenAI-Beta") != "responses=experimental" || h.Get("Authorization") != "Bearer original" || h.Get("X-Codex-Turn-State") != "opaque" {
			t.Fatal("capabilities or credentials changed")
		}
		probe := http.Header{}
		applyCodexFingerprintProbe(probe, lease)
		if probe.Get("User-Agent") != h.Get("User-Agent") || probe.Get("Version") != h.Get("Version") {
			t.Fatal("probe profile differs")
		}
		target, _ := url.Parse("https://example.invalid/models?client_version=local-version&model=keep")
		applyCodexFingerprintURL(target, lease)
		if target.Query().Get("client_version") != "stable-version" || target.Query().Get("model") != "keep" {
			t.Fatal("URL version mismatch")
		}
	}
}

func TestCodexHTTPSProxyStartsTLSBeforeConnect(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	first := make(chan byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 1)
		if _, err = io.ReadFull(conn, buf); err == nil {
			first <- buf[0]
		}
	}()
	parsed, _ := url.Parse("https://user:password@" + listener.Addr().String())
	dialer := &codexHTTPConnectDialer{proxyURL: parsed, forward: &net.Dialer{Timeout: time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp", "example.invalid:443")
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("untrusted/non-TLS proxy accepted")
	}
	select {
	case b := <-first:
		if b != 0x16 {
			t.Fatalf("expected TLS handshake, got %q", b)
		}
	case <-ctx.Done():
		t.Fatal("no proxy handshake")
	}
	if strings.Contains(err.Error(), "password") {
		t.Fatal("proxy credentials leaked")
	}
}

package main

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestParseEgressProxy(t *testing.T) {
	cases := []struct {
		in      string
		scheme  string
		wantErr bool
	}{
		{"", "", false},
		{"  ", "", false},
		{"socks5://user:pass@host:1080", "socks5", false},
		{"http://host:8080", "http", false},
		{"https://host:8443", "https", false},
		{"ftp://nope", "", true},
		{"://bad", "", true},
	}
	for _, c := range cases {
		scheme, _, err := parseEgressProxy(c.in)
		if c.wantErr && err == nil {
			t.Errorf("parseEgressProxy(%q) expected error", c.in)
		}
		if !c.wantErr && err != nil {
			t.Errorf("parseEgressProxy(%q) unexpected error: %v", c.in, err)
		}
		if !c.wantErr && scheme != c.scheme {
			t.Errorf("parseEgressProxy(%q) scheme = %q, want %q", c.in, scheme, c.scheme)
		}
	}
}

func TestDialRawThroughProxyDirect(t *testing.T) {
	// With no proxy, dialRawThroughProxy连直连目标。起一个本地 echo TCP server。
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
		_, _ = conn.Write([]byte("hi"))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dialRawThroughProxy(ctx, ln.Addr().String(), "")
	if err != nil {
		t.Fatalf("dialRawThroughProxy direct: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "hi" {
		t.Fatalf("got %q want hi", string(buf))
	}
}

func TestNewClaudeUpstreamClientBuilds(t *testing.T) {
	// 直连(无代理)与 socks5 代理都应能构造出 client(不实际连)。
	if c := newClaudeUpstreamClient(""); c == nil || c.Transport == nil {
		t.Fatal("direct client should build")
	}
	if c := newClaudeUpstreamClient("socks5://127.0.0.1:1080"); c == nil || c.Transport == nil {
		t.Fatal("socks5 client should build")
	}
}

package main

import (
	"net"
	"testing"
)

// 已有监听器时再次 Start 不应静默保留旧会话凭据。登录刷新/看门狗竞态会走到这里；
// 若 token 仍为空，Codex 就会从本地 48800 收到 503。
func TestLocalHTTPProxyStartRefreshesRuntimeConfig(t *testing.T) {
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := reserved.Addr().(*net.TCPAddr).Port
	_ = reserved.Close()

	p := &LocalHTTPProxy{}
	if err := p.Start(port, "old-token", "old-device", "old-proxy"); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	t.Cleanup(p.Stop)

	if err := p.Start(port, "new-token", "new-device", "new-proxy"); err != nil {
		t.Fatalf("second Start: %v", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.card != "new-token" || p.deviceId != "new-device" || p.upstreamProxy != "new-proxy" {
		t.Fatalf("runtime config not refreshed: card=%q device=%q upstream=%q", p.card, p.deviceId, p.upstreamProxy)
	}
}

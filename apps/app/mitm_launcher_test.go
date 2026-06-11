package main

import (
	"strings"
	"testing"
)

func envMap(env []string) map[string]string {
	m := make(map[string]string, len(env))
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

// route A：带代理 env 重启 Claude.app，子进程(Node 的 Code/Cowork)继承后走 MITM。
// mitmProxyEnv 必须注入 HTTPS_PROXY/HTTP_PROXY 指向本地 MITM、NODE_EXTRA_CA_CERTS
// 指向根 CA、放行 TLS 自签、且本地地址不走代理；已存在的同名变量应被覆盖而非重复。
func TestMitmProxyEnv(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HTTPS_PROXY=http://stale:1", "FOO=bar"}
	out := mitmProxyEnv(base, "127.0.0.1:48801", "/Users/x/.bcai/mitm/ca.crt")
	m := envMap(out)

	if m["HTTPS_PROXY"] != "http://127.0.0.1:48801" {
		t.Errorf("HTTPS_PROXY = %q, want overwritten to MITM addr", m["HTTPS_PROXY"])
	}
	if m["HTTP_PROXY"] != "http://127.0.0.1:48801" {
		t.Errorf("HTTP_PROXY = %q", m["HTTP_PROXY"])
	}
	if m["NODE_EXTRA_CA_CERTS"] != "/Users/x/.bcai/mitm/ca.crt" {
		t.Errorf("NODE_EXTRA_CA_CERTS = %q", m["NODE_EXTRA_CA_CERTS"])
	}
	if m["NODE_TLS_REJECT_UNAUTHORIZED"] != "0" {
		t.Errorf("NODE_TLS_REJECT_UNAUTHORIZED = %q, want 0", m["NODE_TLS_REJECT_UNAUTHORIZED"])
	}
	if !strings.Contains(m["NO_PROXY"], "127.0.0.1") {
		t.Errorf("NO_PROXY = %q, want to contain 127.0.0.1", m["NO_PROXY"])
	}
	// 保留无关变量、且 HTTPS_PROXY 不重复
	if m["PATH"] != "/usr/bin" || m["FOO"] != "bar" {
		t.Errorf("unrelated env vars not preserved: %v", m)
	}
	count := 0
	for _, kv := range out {
		if strings.HasPrefix(kv, "HTTPS_PROXY=") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("HTTPS_PROXY appears %d times, want exactly 1 (upsert, no dup)", count)
	}
}

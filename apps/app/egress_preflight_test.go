package main

import (
	"errors"
	"testing"
)

func TestLooksBanned(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// 用户实测的真实报错(整条)应判为 banned。
		{"proxy CONNECT failed: HTTP/1.1 403 Forbidden ... Mainland China IP 113.87.26.13 banned", true},
		{"403 Forbidden", true},
		{"Forbidden", true},
		{"this ip is BANNED", true},
		{"Mainland China clients are not allowed", true},
		// 普通网络错误不是 banned —— 不能误判,否则会把「该提示开 TUN」说成「连不通」反之亦然。
		{"dial tcp 1.2.3.4:443: connect: connection refused", false},
		{"context deadline exceeded (Client.Timeout exceeded while awaiting headers)", false},
		{"EOF", false},
		{"", false},
	}
	for _, c := range cases {
		if got := looksBanned(c.in); got != c.want {
			t.Errorf("looksBanned(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestClassifyEgressError(t *testing.T) {
	if got := classifyEgressError(nil); got != nil {
		t.Errorf("classifyEgressError(nil) = %v, want nil", got)
	}
	// 封禁类 → errEgressBanned。
	banned := classifyEgressError(errors.New("Get \"https://api.ipify.org\": proxyconnect tcp: 403 Forbidden"))
	if !errors.Is(banned, errEgressBanned) {
		t.Errorf("封禁错误应归类为 errEgressBanned, got %v", banned)
	}
	// 普通传输错误 → 非 banned,但仍是错误(连不通)。
	other := classifyEgressError(errors.New("dial tcp: i/o timeout"))
	if other == nil {
		t.Fatal("普通传输错误不应被吞成 nil")
	}
	if errors.Is(other, errEgressBanned) {
		t.Errorf("普通传输错误不应归类为 errEgressBanned, got %v", other)
	}
}

// enforceEgressGate 对未知/空产品(池子卡)必须直接放行,不发任何探测。
func TestEnforceEgressGateSkipsEmptyProduct(t *testing.T) {
	if err := enforceEgressGate("", Config{}); err != nil {
		t.Errorf("空 product 应放行, got %v", err)
	}
}

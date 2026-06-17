package main

import (
	"errors"
	"strings"
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

// neverProbe 是测试桩:出口探测绝不应被调用(取出口配置失败时根本无代理可探)。
func neverProbe(t *testing.T) func(target, proxyURL string) error {
	return func(target, proxyURL string) error {
		t.Fatalf("不应触发出口探测: target=%s proxy=%s", target, proxyURL)
		return nil
	}
}

// 取出口配置(租号/控制面)失败时,这是「号池无可用账号」一类的控制面错误,不是出口问题。
// 闸必须放行,交由下游真正的接管租号路径用服务器原话如实报错 —— 绝不能 fail-closed 成
// 「为避免暴露真实 IP」的出口强提示(更不能带 EGRESS_BLOCKED 前缀触发开-TUN 引导)。
func TestEnforceEgressGatePassesThroughWhenLeaseFails(t *testing.T) {
	fetch := func(product string, cfg Config) (EgressInfo, error) {
		return EgressInfo{}, errors.New("No account with projectId is available.")
	}
	err := enforceEgressGateWith("antigravity", Config{}, fetch, neverProbe(t))
	if err != nil {
		t.Fatalf("取出口配置失败应放行(交由下游如实报错), got %v", err)
	}
}

// optional 产品(antigravity/codex)成功取到出口配置但未绑代理:本地直连 fail-open,放行不探。
func TestEnforceEgressGatePassesOptionalWithoutProxy(t *testing.T) {
	fetch := func(product string, cfg Config) (EgressInfo, error) {
		return EgressInfo{ProxyURL: "", EgressRequired: false}, nil
	}
	if err := enforceEgressGateWith("antigravity", Config{}, fetch, neverProbe(t)); err != nil {
		t.Fatalf("optional 无代理应放行, got %v", err)
	}
}

// required 产品(anthropic)成功取到配置但未下发代理:硬拒,且带 EGRESS_BLOCKED 让前端弹强提示。
func TestEnforceEgressGateBlocksRequiredWithoutProxy(t *testing.T) {
	fetch := func(product string, cfg Config) (EgressInfo, error) {
		return EgressInfo{ProxyURL: "", EgressRequired: true}, nil
	}
	err := enforceEgressGateWith("anthropic", Config{}, fetch, neverProbe(t))
	if err == nil {
		t.Fatal("required 无代理应硬拒")
	}
	if !strings.Contains(err.Error(), egressGateMarker) {
		t.Errorf("required 无代理的拒绝应带 %q 前缀, got %v", egressGateMarker, err)
	}
}

// 取到代理但探测被代理按来源 IP 拒(banned):带 EGRESS_BLOCKED,提示开 TUN。
func TestEnforceEgressGateBlocksOnBannedProbe(t *testing.T) {
	fetch := func(product string, cfg Config) (EgressInfo, error) {
		return EgressInfo{ProxyURL: "http://user:pass@1.2.3.4:8080", EgressRequired: false}, nil
	}
	probe := func(target, proxyURL string) error { return errEgressBanned }
	err := enforceEgressGateWith("antigravity", Config{}, fetch, probe)
	if err == nil || !strings.Contains(err.Error(), egressGateMarker) {
		t.Fatalf("banned 探测应带 %q 前缀拒绝, got %v", egressGateMarker, err)
	}
}

// 取到代理且探测通过:放行接管。
func TestEnforceEgressGatePassesOnReachableProbe(t *testing.T) {
	fetch := func(product string, cfg Config) (EgressInfo, error) {
		return EgressInfo{ProxyURL: "http://user:pass@1.2.3.4:8080", EgressRequired: false}, nil
	}
	probe := func(target, proxyURL string) error { return nil }
	if err := enforceEgressGateWith("antigravity", Config{}, fetch, probe); err != nil {
		t.Fatalf("探测通过应放行, got %v", err)
	}
}

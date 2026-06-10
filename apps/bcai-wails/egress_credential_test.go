package main

import (
	"strconv"
	"testing"
)

func TestBearerToken(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":   "abc",
		"bearer abc":   "abc",  // 大小写不敏感
		"BEARER  xyz ": "xyz",  // 多空格 + 尾部 trim
		"Basic abc":    "",     // 非 Bearer
		"":             "",     // 空
		"abc":          "",     // 无 scheme
		"Bearer ":      "",     // 只有 scheme 无 token
	}
	for in, want := range cases {
		if got := bearerToken(in); got != want {
			t.Errorf("bearerToken(%q)=%q want %q", in, got, want)
		}
	}
}

func TestPoolTokenRegistry(t *testing.T) {
	registerPoolToken("tok-A", "socks5://res-a:1080")
	if p, ok := lookupPoolToken("tok-A"); !ok || p != "socks5://res-a:1080" {
		t.Fatalf("tok-A 应命中且带代理,got p=%q ok=%v", p, ok)
	}
	registerPoolToken("", "x") // 空 token 不登记
	if _, ok := lookupPoolToken(""); ok {
		t.Error("空 token 不应命中")
	}
	if _, ok := lookupPoolToken("never-registered"); ok {
		t.Error("未登记 token 不应命中")
	}
	if p, ok := lookupPoolToken("  tok-A  "); !ok || p != "socks5://res-a:1080" {
		t.Errorf("token 应 trim 后命中,got p=%q ok=%v", p, ok)
	}
}

func TestPoolTokenRegistryEviction(t *testing.T) {
	// 登记哨兵后灌满超上限,哨兵应被 FIFO 淘汰(防内存无限增长)。
	registerPoolToken("evict-sentinel", "p0")
	for i := 0; i < poolTokenRegistryMax+5; i++ {
		registerPoolToken("evict-fill-"+strconv.Itoa(i), "pf")
	}
	if _, ok := lookupPoolToken("evict-sentinel"); ok {
		t.Error("哨兵应已被 FIFO 淘汰")
	}
	// 最新登记的仍在。
	if _, ok := lookupPoolToken("evict-fill-" + strconv.Itoa(poolTokenRegistryMax+4)); !ok {
		t.Error("最新登记的不应被淘汰")
	}
}

func TestResolveCredentialEgress(t *testing.T) {
	registerPoolToken("pool-with-proxy", "socks5://static:1080")
	registerPoolToken("pool-no-proxy", "") // 号池 token 但该号未下发静态出口

	t.Run("号池token有静态IP→走静态IP", func(t *testing.T) {
		p, blocked, isPool := resolveCredentialEgress("Bearer pool-with-proxy", "http://user:7890")
		if !isPool || blocked || p != "socks5://static:1080" {
			t.Errorf("got p=%q blocked=%v isPool=%v", p, blocked, isPool)
		}
	})
	t.Run("号池token无静态IP→fail-closed拒连", func(t *testing.T) {
		_, blocked, isPool := resolveCredentialEgress("Bearer pool-no-proxy", "http://user:7890")
		if !isPool || !blocked {
			t.Errorf("应 blocked,got blocked=%v isPool=%v", blocked, isPool)
		}
	})
	t.Run("用户自己token→用户网络,绝不静态IP", func(t *testing.T) {
		p, blocked, isPool := resolveCredentialEgress("Bearer users-own-token", "http://user:7890")
		if isPool || blocked || p != "http://user:7890" {
			t.Errorf("got p=%q blocked=%v isPool=%v", p, blocked, isPool)
		}
	})
	t.Run("无Authorization→用户网络", func(t *testing.T) {
		p, blocked, isPool := resolveCredentialEgress("", "http://user:7890")
		if isPool || blocked || p != "http://user:7890" {
			t.Errorf("got p=%q blocked=%v isPool=%v", p, blocked, isPool)
		}
	})
	t.Run("非号池+用户也无代理→直连兜底(空)", func(t *testing.T) {
		p, blocked, isPool := resolveCredentialEgress("Bearer another-user-token", "")
		if isPool || blocked || p != "" {
			t.Errorf("got p=%q blocked=%v isPool=%v", p, blocked, isPool)
		}
	})
}

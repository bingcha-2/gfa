package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/account"
)

// Wave L:按号服务档在喂给网关的 auth 记录上以出口口径("priority")透出。
//
// 这是 egress 注入的边界测试:真正把 service_tier 塞进出口请求体尚未接线(见 store.go
// 的 TODO —— 嵌入式 CLIProxyAPI v7.2.47 无逐号请求体注入钩子),故这里只断言「档位已
// 正确归一并暴露在 auth.Attributes["service_tier"] 上」,作为未来接线的读取契约。
func TestStore_ServiceTierSurfacedToAuth(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	fast := &account.Account{Provider: account.ProviderCodex, Email: "fast@y.com", AuthKind: account.AuthOAuth,
		RefreshToken: "rt", PoolEnabled: true, ServiceTier: "fast"}
	std := &account.Account{Provider: account.ProviderCodex, Email: "std@y.com", AuthKind: account.AuthOAuth,
		RefreshToken: "rt2", PoolEnabled: true} // 无档位 = 继承
	_ = acc.Add(fast)
	_ = acc.Add(std)

	st := NewStore(acc, account.ProviderCodex)
	auths, err := st.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	byEmail := map[string]string{}
	for _, a := range auths {
		byEmail[a.Label] = a.Attributes["service_tier"]
	}
	if byEmail["fast@y.com"] != "priority" {
		t.Fatalf("fast account should surface upstream tier \"priority\", got %q", byEmail["fast@y.com"])
	}
	if byEmail["std@y.com"] != "" {
		t.Fatalf("standard/inherit account should surface empty tier, got %q", byEmail["std@y.com"])
	}
}

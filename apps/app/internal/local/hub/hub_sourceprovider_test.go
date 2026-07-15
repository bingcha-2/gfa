package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/modelprovider"
	"bcai-wails/internal/local/takeover"
)

// 激活自定义厂商:SetSource("provider:<id>") 应先撤自有号注入、再注入厂商,并记住厂商 id。
func TestHub_SetSourceProvider_InjectsProvider(t *testing.T) {
	h, fp := newHub(t)
	saved, err := h.SaveModelProvider(modelprovider.Provider{
		Name: "MyVendor", BaseURL: "https://api.vendor.com/v1", APIKey: "sk-xyz",
	})
	if err != nil {
		t.Fatalf("SaveModelProvider: %v", err)
	}

	if err := h.SetSource(account.ProviderCodex, "provider:"+saved.ID); err != nil {
		t.Fatalf("SetSource provider: %v", err)
	}

	if fp.codexProviderInjectCount != 1 {
		t.Fatalf("CodexInjectProvider 调用 %d 次,want 1", fp.codexProviderInjectCount)
	}
	if fp.codexRestoreCount < 1 {
		t.Fatal("激活厂商前应先 CodexRestoreAccount 撤自有号注入(互斥)")
	}
	if fp.codexProviderInjectCount == 1 {
		p := fp.codexInjectedProvider
		if p.BaseURL != "https://api.vendor.com/v1" || p.APIKey != "sk-xyz" || p.Name != "MyVendor" {
			t.Fatalf("注入厂商字段不符: %+v", p)
		}
		if p.WireAPI == "" {
			t.Fatal("WireAPI 应从 provider 归一带出,不应为空")
		}
	}
	// 号源 + 选中 id 持久化。
	if h.GetSource(account.ProviderCodex) != string(takeover.SourceProvider) {
		t.Fatalf("GetSource = %q, want provider", h.GetSource(account.ProviderCodex))
	}
	if id := h.sources.GetProviderID(string(account.ProviderCodex)); id != saved.ID {
		t.Fatalf("持久化 provider id = %q, want %q", id, saved.ID)
	}
}

// 未知厂商 id → 报错,不注入。
func TestHub_SetSourceProvider_UnknownID(t *testing.T) {
	h, fp := newHub(t)
	if err := h.SetSource(account.ProviderCodex, "provider:nope"); err == nil {
		t.Fatal("未知厂商 id 应报错")
	}
	if fp.codexProviderInjectCount != 0 {
		t.Fatal("未知厂商不应注入")
	}
}

// 厂商 → 远程:应清掉 config.toml 厂商表(CodexRestoreProvider)。
func TestHub_SetSourceProvider_SwitchToRemoteClearsProvider(t *testing.T) {
	h, fp := newHub(t)
	saved, _ := h.SaveModelProvider(modelprovider.Provider{Name: "V", BaseURL: "http://v/v1", APIKey: "k"})
	if err := h.SetSource(account.ProviderCodex, "provider:"+saved.ID); err != nil {
		t.Fatalf("SetSource provider: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("SetSource remote: %v", err)
	}
	if fp.codexProviderRestoreCount != 1 {
		t.Fatalf("切远程时 CodexRestoreProvider 调用 %d 次,want 1", fp.codexProviderRestoreCount)
	}
	if h.GetSource(account.ProviderCodex) != string(takeover.SourceRemote) {
		t.Fatalf("GetSource = %q, want remote", h.GetSource(account.ProviderCodex))
	}
}

// 厂商 → 本地自有号:local 注入内部会清 config.toml(不需要额外 RestoreProvider),
// 且不再残留 provider id。
func TestHub_SetSourceProvider_SwitchToLocal(t *testing.T) {
	h, fp := newHub(t)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "own@x.com", PoolEnabled: true})
	saved, _ := h.SaveModelProvider(modelprovider.Provider{Name: "V", BaseURL: "http://v/v1", APIKey: "k"})
	if err := h.SetSource(account.ProviderCodex, "provider:"+saved.ID); err != nil {
		t.Fatalf("SetSource provider: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("SetSource local: %v", err)
	}
	if fp.codexInjectCount != 1 {
		t.Fatalf("切本地应注入自有号一次,got %d", fp.codexInjectCount)
	}
	if h.sources.GetProviderID(string(account.ProviderCodex)) != "" {
		t.Fatal("切本地后不应残留 provider id")
	}
}

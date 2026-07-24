package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSampleConfig(t *testing.T) (home, cfgPath string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cfgPath = filepath.Join(home, "config.toml")
	if err := os.WriteFile(cfgPath, []byte(sampleConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	return home, cfgPath
}

// 激活自定义厂商:写固定 provider 表 + model_provider,保留用户内容。
func TestInjectCodexProvider_WritesTable(t *testing.T) {
	_, cfgPath := writeSampleConfig(t)

	err := InjectCodexProvider(codexProviderSpec{
		Name: "MyVendor", BaseURL: "https://api.vendor.com/v1", APIKey: "sk-abc", WireAPI: "responses",
	})
	if err != nil {
		t.Fatalf("InjectCodexProvider: %v", err)
	}
	got, _ := os.ReadFile(cfgPath)
	for _, must := range []string{
		`model_provider = "gfa_local_provider"`,
		`[model_providers.gfa_local_provider]`,
		`name = "MyVendor"`,
		`base_url = "https://api.vendor.com/v1"`,
		`wire_api = "responses"`,
		`requires_openai_auth = true`,
		`experimental_bearer_token = "sk-abc"`,
	} {
		if !strings.Contains(string(got), must) {
			t.Fatalf("激活后缺少 %q:\n%s", must, got)
		}
	}
	// 顶层 openai_base_url 不应存在(自定义 provider 走表内 base_url)。
	if strings.Contains(string(got), "openai_base_url") {
		t.Fatalf("不应有顶层 openai_base_url:\n%s", got)
	}
	// 用户内容保留。
	for _, must := range []string{"# top comment", "[desktop]", "model = 'gpt-5.5'", "[projects.'/Users/x/proj']"} {
		if !strings.Contains(string(got), must) {
			t.Fatalf("激活后丢失用户内容 %q:\n%s", must, got)
		}
	}
}

// 空 key → requires_openai_auth=false,无 bearer。
func TestInjectCodexProvider_NoKey(t *testing.T) {
	_, cfgPath := writeSampleConfig(t)
	if err := InjectCodexProvider(codexProviderSpec{Name: "NoAuth", BaseURL: "http://local/v1"}); err != nil {
		t.Fatalf("InjectCodexProvider: %v", err)
	}
	got, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(got), "requires_openai_auth = false") {
		t.Fatalf("无 key 应 requires_openai_auth=false:\n%s", got)
	}
	if strings.Contains(string(got), "experimental_bearer_token") {
		t.Fatalf("无 key 不应写 bearer:\n%s", got)
	}
	// 缺省 wire_api 回落 responses。
	if !strings.Contains(string(got), `wire_api = "responses"`) {
		t.Fatalf("缺省 wire_api 应回落 responses:\n%s", got)
	}
}

// 激活 → 还原:provider 表被干净移除,用户内容保留。
func TestInjectCodexProvider_RestoreRemovesTable(t *testing.T) {
	_, cfgPath := writeSampleConfig(t)
	if err := InjectCodexProvider(codexProviderSpec{Name: "V", BaseURL: "http://v/v1", APIKey: "k"}); err != nil {
		t.Fatalf("inject: %v", err)
	}
	if err := RestoreCodexSettings(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	got, _ := os.ReadFile(cfgPath)
	for _, gone := range []string{"gfa_local_provider", "model_provider", "experimental_bearer_token"} {
		if strings.Contains(string(got), gone) {
			t.Fatalf("还原后仍残留 %q:\n%s", gone, got)
		}
	}
	for _, must := range []string{"# top comment", "model = 'gpt-5.5'", "[desktop]"} {
		if !strings.Contains(string(got), must) {
			t.Fatalf("还原后丢失用户内容 %q:\n%s", must, got)
		}
	}
}

// 互斥:先激活本地厂商,再切远程托管→ 本地厂商表必须被清掉,
// 只剩 bingchaai 远程 provider（本测试无真实 OAuth，因此无需 OpenAI 鉴权）。
func TestInjectCodexProvider_MutualExclusionWithRemote(t *testing.T) {
	_, cfgPath := writeSampleConfig(t)
	if err := InjectCodexProvider(codexProviderSpec{Name: "V", BaseURL: "http://v/v1", APIKey: "k"}); err != nil {
		t.Fatalf("inject provider: %v", err)
	}
	// 切远程托管前必须先还原(对齐 hub 的互斥流程),再注入远程重定向。
	if err := RestoreCodexSettings(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if err := InjectCodexSettings(8080); err != nil {
		t.Fatalf("inject remote: %v", err)
	}
	got, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(got), "gfa_local_provider") {
		t.Fatalf("切远程后厂商表未清:\n%s", got)
	}
	if !strings.Contains(string(got), `model_provider = "bingchaai"`) ||
		!strings.Contains(string(got), `[model_providers.bingchaai]`) ||
		!strings.Contains(string(got), `name = "冰茶 AI"`) ||
		!strings.Contains(string(got), `base_url = "http://127.0.0.1:8080/v1"`) ||
		!strings.Contains(string(got), `requires_openai_auth = false`) ||
		!strings.Contains(string(got), `experimental_bearer_token = "gfa_codex_takeover"`) ||
		!strings.Contains(string(got), `http_headers = { "x-openai-actor-authorization" = "bingchaai" }`) {
		t.Fatalf("远程重定向未生效:\n%s", got)
	}
}

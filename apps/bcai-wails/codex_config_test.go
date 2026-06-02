package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleConfig = `# top comment
approval_policy = 'never'
model = 'gpt-5.5'
notify = ['/a/b c/x', 'turn-ended']

[desktop]
appearanceTheme = 'light'

[projects.'/Users/x/Documents/Codex/2026-05-06/11-33']
trust_level = 'trusted'

[projects.'/Users/x/proj']
trust_level = 'trusted'
`

func TestSetTopLevelStringInsertAndReplace(t *testing.T) {
	// 插入新键:应出现在顶层区,且不破坏后续表。
	out := setTopLevelString(sampleConfig, "model_provider", "bingchaai")
	if !strings.Contains(out, `model_provider = "bingchaai"`) {
		t.Fatalf("model_provider 未写入:\n%s", out)
	}
	if !strings.Contains(out, "[desktop]") || !strings.Contains(out, "trust_level = 'trusted'") {
		t.Fatalf("后续表被破坏:\n%s", out)
	}
	if strings.Count(out, "model = 'gpt-5.5'") != 1 {
		t.Fatalf("原有键被改动")
	}
	// model_provider 必须在第一个表头之前。
	if idxKey, idxTable := strings.Index(out, "model_provider"), strings.Index(out, "[desktop]"); idxKey > idxTable {
		t.Fatalf("model_provider 落到了表内 idxKey=%d idxTable=%d", idxKey, idxTable)
	}

	// 替换已存在键。
	again := setTopLevelString(out, "model_provider", "openai")
	if strings.Count(again, "model_provider") != 1 {
		t.Fatalf("替换后出现重复键:\n%s", again)
	}
	if !strings.Contains(again, `model_provider = "openai"`) {
		t.Fatalf("替换失败:\n%s", again)
	}
}

func TestRemoveTopLevelKey(t *testing.T) {
	with := setTopLevelString(sampleConfig, "model_provider", "bingchaai")
	out := removeTopLevelKey(with, "model_provider")
	if strings.Contains(out, "model_provider") {
		t.Fatalf("model_provider 未被删除:\n%s", out)
	}
	// 不应误删值里含 model 的其它键。
	if !strings.Contains(out, "model = 'gpt-5.5'") {
		t.Fatalf("误删了 model 键")
	}
}

func TestUpsertAndRemoveProviderTable(t *testing.T) {
	out := upsertProviderTable(sampleConfig, "bingchaai", [][2]string{
		{"name", tomlQuote("BingchaAI")},
		{"base_url", tomlQuote("http://127.0.0.1:8080/v1")},
		{"wire_api", tomlQuote("responses")},
		{"requires_openai_auth", "false"},
	})
	if !strings.Contains(out, "[model_providers.bingchaai]") {
		t.Fatalf("provider 表未写入:\n%s", out)
	}
	if !strings.Contains(out, `base_url = "http://127.0.0.1:8080/v1"`) {
		t.Fatalf("base_url 未写入")
	}

	// 重复 upsert 应替换而非追加。
	out2 := upsertProviderTable(out, "bingchaai", [][2]string{
		{"name", tomlQuote("BingchaAI")},
		{"base_url", tomlQuote("http://127.0.0.1:9999/v1")},
	})
	if strings.Count(out2, "[model_providers.bingchaai]") != 1 {
		t.Fatalf("provider 表重复:\n%s", out2)
	}
	if !strings.Contains(out2, "9999") || strings.Contains(out2, "8080") {
		t.Fatalf("provider 表未被替换:\n%s", out2)
	}

	// 删除后应彻底消失,其余配置保留。
	removed := removeProviderTable(out2, "bingchaai")
	if strings.Contains(removed, "model_providers.bingchaai") {
		t.Fatalf("provider 表未删除:\n%s", removed)
	}
	if !strings.Contains(removed, "[desktop]") || !strings.Contains(removed, "[projects.'/Users/x/proj']") {
		t.Fatalf("删除 provider 表时破坏了其它表:\n%s", removed)
	}
}

// 完整接管→还原:原本无 model_provider 的场景(对应用户真实配置)。
// provider 模式:写 model_provider + [model_providers.bingchaai],含 supports_websockets=false。
func TestInjectRestoreRoundTripNoPriorProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cfgPath := filepath.Join(home, "config.toml")
	if err := os.WriteFile(cfgPath, []byte(sampleConfig), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := InjectCodexSettings(8080); err != nil {
		t.Fatalf("inject: %v", err)
	}
	if !IsCodexInjected() {
		t.Fatalf("注入后 IsCodexInjected=false")
	}
	injected, _ := os.ReadFile(cfgPath)
	for _, must := range []string{
		`model_provider = "bingchaai"`,
		`[model_providers.bingchaai]`,
		`base_url = "http://127.0.0.1:8080/v1"`,
		`supports_websockets = false`, // 关键:强制走 HTTP 不走 wss
		`requires_openai_auth = false`,
	} {
		if !strings.Contains(string(injected), must) {
			t.Fatalf("注入后缺少 %q:\n%s", must, injected)
		}
	}

	if err := RestoreCodexSettings(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	restored, _ := os.ReadFile(cfgPath)
	// 原本没有 provider,还原后应彻底移除。
	if strings.Contains(string(restored), "model_provider") || strings.Contains(string(restored), "bingchaai") {
		t.Fatalf("还原后仍残留 provider:\n%s", restored)
	}
	// 关键:用户的 projects / desktop / 注释 全部保留。
	for _, must := range []string{"# top comment", "[desktop]", "[projects.'/Users/x/proj']", "model = 'gpt-5.5'"} {
		if !strings.Contains(string(restored), must) {
			t.Fatalf("还原后丢失了 %q:\n%s", must, restored)
		}
	}
}

// 完整接管→还原:有原自定义 model_provider 的场景,应被恢复。
func TestInjectRestoreRoundTripWithPriorProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cfgPath := filepath.Join(home, "config.toml")
	prior := "model_provider = 'myprovider'\n" + sampleConfig
	if err := os.WriteFile(cfgPath, []byte(prior), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := InjectCodexSettings(8080); err != nil {
		t.Fatalf("inject: %v", err)
	}
	injected, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(injected), `model_provider = "bingchaai"`) {
		t.Fatalf("注入后未切到 bingchaai:\n%s", injected)
	}

	if err := RestoreCodexSettings(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	restored, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(restored), `model_provider = "myprovider"`) {
		t.Fatalf("还原后未恢复原 provider:\n%s", restored)
	}
	if strings.Contains(string(restored), "bingchaai") {
		t.Fatalf("还原后仍残留 bingchaai:\n%s", restored)
	}
}

func TestStripLegacyLocalCodexBaseURL(t *testing.T) {
	// 旧版接管残留:顶层 chatgpt_base_url 指向本地代理 → 应被清掉,其余配置保留。
	withLocal := "model = 'gpt-5.5'\n" +
		"chatgpt_base_url = \"http://127.0.0.1:60670/backend-api/codex\"\n\n" +
		"[desktop]\nappearanceTheme = 'light'\n"
	out := stripLegacyLocalCodexBaseURL(withLocal)
	if strings.Contains(out, "chatgpt_base_url") {
		t.Fatalf("本地 chatgpt_base_url 应被删除:\n%s", out)
	}
	if !strings.Contains(out, "model = 'gpt-5.5'") || !strings.Contains(out, "[desktop]") {
		t.Fatalf("其余配置必须保留:\n%s", out)
	}

	// 用户自定义的远程 chatgpt_base_url 不能动。
	withRemote := "chatgpt_base_url = \"https://api.example.com/v1\"\n"
	if got := stripLegacyLocalCodexBaseURL(withRemote); got != withRemote {
		t.Fatalf("非本地 chatgpt_base_url 必须保留,得到:\n%s", got)
	}

	// 不存在该键时无操作。
	none := "model = 'gpt-5.5'\n"
	if got := stripLegacyLocalCodexBaseURL(none); got != none {
		t.Fatalf("缺该键应无操作")
	}
}

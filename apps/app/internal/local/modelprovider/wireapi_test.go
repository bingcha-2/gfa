package modelprovider

import "testing"

func TestNormalizeWireAPIExplicit(t *testing.T) {
	cases := map[string]WireAPI{
		"responses":         WireResponses,
		"chat_completions":  WireChatCompletions,
		"openai":            WireChatCompletions,
		"Chat-Completions ": WireChatCompletions,
	}
	for in, want := range cases {
		if got := NormalizeWireAPI(in, "https://example.com"); got != want {
			t.Errorf("NormalizeWireAPI(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeWireAPIHeuristic(t *testing.T) {
	if got := NormalizeWireAPI("", "https://api.deepseek.com/v1"); got != WireChatCompletions {
		t.Errorf("deepseek heuristic = %q, want chat_completions", got)
	}
	if got := NormalizeWireAPI("", "https://openrouter.ai/api/v1"); got != WireChatCompletions {
		t.Errorf("openrouter heuristic = %q, want chat_completions", got)
	}
	// 未知域名默认 responses(codex 原生)。
	if got := NormalizeWireAPI("", "https://api.openai.com/v1"); got != WireResponses {
		t.Errorf("default heuristic = %q, want responses", got)
	}
	if got := NormalizeWireAPI("garbage", "https://api.openai.com/v1"); got != WireResponses {
		t.Errorf("unknown value falls back via heuristic = %q, want responses", got)
	}
}

func TestModelsURL(t *testing.T) {
	cases := map[string]string{
		"https://api.openai.com/v1":  "https://api.openai.com/v1/models",
		"https://api.openai.com/v1/": "https://api.openai.com/v1/models",
		"https://api.openai.com":     "https://api.openai.com/models",
		"https://h/v1?x=1":           "https://h/v1/models",
	}
	for in, want := range cases {
		got, err := modelsURL(in)
		if err != nil {
			t.Fatalf("modelsURL(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("modelsURL(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "  ", "ftp://x", "notaurl", "/relative"} {
		if _, err := modelsURL(bad); err == nil {
			t.Errorf("modelsURL(%q) expected error", bad)
		}
	}
}

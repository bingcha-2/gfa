package main

import "testing"

func TestModelFamily(t *testing.T) {
	cases := map[string]string{
		"gemini-3-pro":             "gemini",
		"gemini-2.5-flash":         "gemini",
		"gpt-5-codex":              "gpt",
		"gpt-5.2":                  "gpt",
		"claude-opus-4-6-thinking": "claude",
		"claude-sonnet-4-6":        "claude",
		"some-future-model":        "claude",
	}
	for model, want := range cases {
		if got := modelFamily(model); got != want {
			t.Errorf("modelFamily(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestBucketKeySplitsOpusByProduct(t *testing.T) {
	// The crux: the old flat "opus" bucket was shared by antigravity + anthropic.
	// Composite keys split it by product so a card covering both never cross-counts.
	cases := []struct {
		product, model, want string
	}{
		{"antigravity", "claude-opus-4-6", "antigravity-claude"},
		{"anthropic", "claude-opus-4-6", "anthropic-claude"},
		{"antigravity", "gemini-3-pro", "antigravity-gemini"},
		{"codex", "gpt-5-codex", "codex-gpt"},
	}
	for _, c := range cases {
		if got := bucketKey(c.product, c.model); got != c.want {
			t.Errorf("bucketKey(%q, %q) = %q, want %q", c.product, c.model, got, c.want)
		}
	}
}

func TestParseBucketRoundTrip(t *testing.T) {
	cases := []struct{ product, model string }{
		{"antigravity", "gemini-3-pro"},
		{"antigravity", "claude-opus-4-6"},
		{"codex", "gpt-5-codex"},
		{"anthropic", "claude-sonnet-4-6"},
	}
	for _, c := range cases {
		key := bucketKey(c.product, c.model)
		gotProduct, gotFamily := parseBucket(key)
		if gotProduct != c.product || gotFamily != modelFamily(c.model) {
			t.Errorf("parseBucket(%q) = (%q,%q), want (%q,%q)",
				key, gotProduct, gotFamily, c.product, modelFamily(c.model))
		}
	}
}

func TestBucketLabelDistinguishesProduct(t *testing.T) {
	if bucketLabel("antigravity-claude") == bucketLabel("anthropic-claude") {
		t.Errorf("antigravity-claude and anthropic-claude must have distinct labels")
	}
}

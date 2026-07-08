package main

import (
	"encoding/json"
	"testing"
)

func TestCodexPlanSupportsFast(t *testing.T) {
	cases := []struct {
		plan string
		want bool
	}{
		{"pro", true},
		{"Pro", true},
		{"  pro  ", true},
		{"team", true},
		{"business", true},
		{"enterprise", true},
		{"edu", true},
		{"chatgpt_pro", true},
		{"plus", false},
		{"Plus", false},
		{"free", false},
		{"", false},
		{"unknown", false},
	}
	for _, c := range cases {
		if got := codexPlanSupportsFast(c.plan); got != c.want {
			t.Errorf("codexPlanSupportsFast(%q) = %v, want %v", c.plan, got, c.want)
		}
	}
}

// serviceTierOf 解析请求体取出 service_tier(缺失 → "")。
func serviceTierOf(t *testing.T, body []byte) string {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, body)
	}
	s, _ := m["service_tier"].(string)
	return s
}

// 快速档开 + 号支持:Codex 自己不发 service_tier(body 无),代理主动注入 priority。
func TestApplyCodexServiceTier_InjectsWhenFastOnAndCapable(t *testing.T) {
	body := []byte(`{"model":"gpt-5-codex","input":[]}`)
	out := applyCodexServiceTier(body, true, "pro")
	if got := serviceTierOf(t, out); got != "priority" {
		t.Fatalf("service_tier = %q, want priority(应注入)", got)
	}
	var m map[string]interface{}
	_ = json.Unmarshal(out, &m)
	if m["model"] != "gpt-5-codex" {
		t.Fatalf("model field lost: %v", m["model"])
	}
}

// 快速档关:不注入;body 无 service_tier → 保持空。
func TestApplyCodexServiceTier_NoInjectWhenFastOff(t *testing.T) {
	body := []byte(`{"model":"gpt-5-codex"}`)
	out := applyCodexServiceTier(body, false, "pro")
	if got := serviceTierOf(t, out); got != "" {
		t.Fatalf("service_tier = %q, want empty(快速档关不应注入)", got)
	}
}

// 快速档开但被租号 plan 不支持 → 不注入,且剥掉残留 priority。
func TestApplyCodexServiceTier_StripsWhenPlanUnsupported(t *testing.T) {
	body := []byte(`{"model":"gpt-5-codex","service_tier":"priority"}`)
	out := applyCodexServiceTier(body, true, "plus")
	if got := serviceTierOf(t, out); got != "" {
		t.Fatalf("service_tier = %q, want stripped(plus 不支持快速)", got)
	}
}

// 快速档关时,残留的 priority 也要剥掉(回落标准)。
func TestApplyCodexServiceTier_StripsPriorityWhenFastOff(t *testing.T) {
	body := []byte(`{"service_tier":"priority"}`)
	out := applyCodexServiceTier(body, false, "pro")
	if got := serviceTierOf(t, out); got != "" {
		t.Fatalf("service_tier = %q, want stripped", got)
	}
}

// 快速档关时,非快速档(flex/default/auto)保持原样,不干预。
func TestApplyCodexServiceTier_LeavesNonPriorityTierAlone(t *testing.T) {
	for _, tier := range []string{"flex", "default", "auto"} {
		body := []byte(`{"service_tier":"` + tier + `"}`)
		out := applyCodexServiceTier(body, false, "pro")
		if got := serviceTierOf(t, out); got != tier {
			t.Fatalf("tier %q got rewritten to %q", tier, got)
		}
	}
}

func TestApplyCodexServiceTier_IdempotentWhenAlreadyPriority(t *testing.T) {
	body := []byte(`{"service_tier":"priority","model":"x"}`)
	out := applyCodexServiceTier(body, true, "pro")
	// 已是 priority 且开+支持 → 未改动,原样返回(同底层切片)。
	if &out[0] != &body[0] {
		t.Fatalf("expected unchanged body returned as-is")
	}
}

func TestApplyCodexServiceTier_InvalidJSONUnchanged(t *testing.T) {
	body := []byte(`not json`)
	out := applyCodexServiceTier(body, true, "pro")
	if string(out) != "not json" {
		t.Fatalf("invalid JSON should pass through unchanged, got %s", out)
	}
}

func TestCodexRequestServiceTier(t *testing.T) {
	if got := codexRequestServiceTier([]byte(`{"service_tier":"priority"}`)); got != "priority" {
		t.Fatalf("got %q, want priority", got)
	}
	if got := codexRequestServiceTier([]byte(`{"model":"x"}`)); got != "" {
		t.Fatalf("missing tier: got %q, want empty", got)
	}
	if got := codexRequestServiceTier([]byte(`not json`)); got != "" {
		t.Fatalf("invalid json: got %q, want empty", got)
	}
}

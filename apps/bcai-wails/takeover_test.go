package main

import "testing"

func TestTargetRequiredProduct(t *testing.T) {
	cases := map[string]string{
		"codex":           "codex",
		"antigravity_ide": "antigravity",
		"antigravity_hub": "antigravity",
		"unknown":         "",
	}
	for in, want := range cases {
		if got := targetRequiredProduct(in); got != want {
			t.Fatalf("targetRequiredProduct(%q)=%q want %q", in, got, want)
		}
	}
}

func TestCardCoversProduct(t *testing.T) {
	// 池子卡(products 为空)→ 覆盖一切产品。
	if !cardCoversProduct(nil, "antigravity") || !cardCoversProduct([]string{}, "codex") {
		t.Fatal("池子卡应覆盖任意产品")
	}
	// 绑定卡:只覆盖自己绑的产品。
	if !cardCoversProduct([]string{"codex"}, "codex") {
		t.Fatal("codex 卡应覆盖 codex")
	}
	if cardCoversProduct([]string{"codex"}, "antigravity") {
		t.Fatal("codex 卡不应覆盖 antigravity(应拒绝接管)")
	}
	if !cardCoversProduct([]string{"codex", "antigravity"}, "antigravity") {
		t.Fatal("通用卡应覆盖 antigravity")
	}
	// required 为空(未知目标)→ 不限制。
	if !cardCoversProduct([]string{"codex"}, "") {
		t.Fatal("空 required 应放行")
	}
}

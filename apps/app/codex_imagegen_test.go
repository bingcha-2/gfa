package main

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func hasHostedImageTool(body []byte) bool {
	for _, t := range gjson.GetBytes(body, "tools").Array() {
		if t.Get("type").String() == "image_generation" {
			return true
		}
	}
	return false
}

// 无 tools:新建 tools 数组并注入。
func TestEnsureImageGen_NoTools(t *testing.T) {
	out := ensureCodexImageGenerationTool([]byte(`{"model":"gpt-5.6-sol"}`), "gpt-5.6-sol", "pro")
	if !hasHostedImageTool(out) {
		t.Fatalf("应新建 tools 并注入生图工具:\n%s", out)
	}
	if gjson.GetBytes(out, "tools.0.output_format").String() != "png" {
		t.Fatalf("output_format 应为 png:\n%s", out)
	}
}

// 已有 tools:追加,不覆盖原工具。
func TestEnsureImageGen_AppendsToExisting(t *testing.T) {
	in := []byte(`{"model":"gpt-5.5","tools":[{"type":"function","name":"foo"}]}`)
	out := ensureCodexImageGenerationTool(in, "gpt-5.5", "pro")
	if !hasHostedImageTool(out) {
		t.Fatalf("应追加生图工具:\n%s", out)
	}
	if gjson.GetBytes(out, `tools.#(name=="foo")`).Get("name").String() != "foo" {
		t.Fatalf("原工具应保留:\n%s", out)
	}
}

// spark 模型:跳过不注入。
func TestEnsureImageGen_SkipsSpark(t *testing.T) {
	out := ensureCodexImageGenerationTool([]byte(`{"model":"gpt-5.3-codex-spark"}`), "gpt-5.3-codex-spark", "pro")
	if hasHostedImageTool(out) {
		t.Fatalf("spark 模型不应注入:\n%s", out)
	}
}

// free 套餐:跳过不注入。
func TestEnsureImageGen_SkipsFreePlan(t *testing.T) {
	out := ensureCodexImageGenerationTool([]byte(`{"model":"gpt-5.6-sol"}`), "gpt-5.6-sol", "free")
	if hasHostedImageTool(out) {
		t.Fatalf("free 套餐不应注入:\n%s", out)
	}
}

// 已有 hosted 工具:不重复注入(只一个)。
func TestEnsureImageGen_NoDuplicate(t *testing.T) {
	in := []byte(`{"model":"gpt-5.5","tools":[{"type":"image_generation","output_format":"png"}]}`)
	out := ensureCodexImageGenerationTool(in, "gpt-5.5", "pro")
	count := 0
	for _, tl := range gjson.GetBytes(out, "tools").Array() {
		if tl.Get("type").String() == "image_generation" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("hosted 工具应恰一个,got %d:\n%s", count, out)
	}
}

// 客户端自带 image_gen.imagegen 函数:反删 hosted 工具 + 清 tool_choice。
func TestEnsureImageGen_FunctionConflictRemovesHosted(t *testing.T) {
	in := []byte(`{"model":"gpt-5.5","tool_choice":{"type":"tool","name":"image_generation"},"tools":[{"type":"function","name":"image_gen.imagegen"},{"type":"image_generation"}]}`)
	out := ensureCodexImageGenerationTool(in, "gpt-5.5", "pro")
	if hasHostedImageTool(out) {
		t.Fatalf("与客户端 image_gen 冲突时应删掉 hosted 工具:\n%s", out)
	}
	if gjson.GetBytes(out, "tool_choice").Exists() {
		t.Fatalf("冲突时应清掉指向 image_generation 的 tool_choice:\n%s", out)
	}
	// 客户端自己的 image_gen 函数保留。
	if !strings.Contains(string(out), "image_gen.imagegen") {
		t.Fatalf("客户端 image_gen 函数应保留:\n%s", out)
	}
}

// 客户端 namespace 形态 image_gen{tools:[imagegen]}:同样识别为冲突。
func TestEnsureImageGen_NamespaceConflict(t *testing.T) {
	in := []byte(`{"model":"gpt-5.5","tools":[{"type":"image_generation"},{"name":"image_gen","tools":[{"name":"imagegen"}]}]}`)
	out := ensureCodexImageGenerationTool(in, "gpt-5.5", "pro")
	if hasHostedImageTool(out) {
		t.Fatalf("namespace 冲突应删掉 hosted 工具:\n%s", out)
	}
}

package main

import (
	"testing"

	"github.com/tidwall/gjson"
)

// /v1/images/generations JSON → codex responses body(内联生图工具 + tool_choice)。
func TestBuildCodexImagesResponsesBody(t *testing.T) {
	raw := []byte(`{"prompt":"a cute cat fishing","model":"gpt-image-1","size":"1024x1024","quality":"high"}`)
	body := buildCodexImagesResponsesBody(raw)

	if got := gjson.GetBytes(body, "model").String(); got != codexImagesMainModel {
		t.Fatalf("responses model = %q, want %q", got, codexImagesMainModel)
	}
	if got := gjson.GetBytes(body, "input.0.content.0.text").String(); got != "a cute cat fishing" {
		t.Fatalf("prompt not carried: %q", got)
	}
	if got := gjson.GetBytes(body, "tool_choice.type").String(); got != "image_generation" {
		t.Fatalf("tool_choice = %q, want image_generation", got)
	}
	tool := gjson.GetBytes(body, "tools.0")
	if tool.Get("type").String() != "image_generation" || tool.Get("action").String() != "generate" {
		t.Fatalf("tool 不对: %s", tool.Raw)
	}
	if tool.Get("size").String() != "1024x1024" || tool.Get("quality").String() != "high" {
		t.Fatalf("tool 未带 size/quality: %s", tool.Raw)
	}
	if tool.Get("model").String() != "gpt-image-1" {
		t.Fatalf("tool model = %q, want 请求里的 gpt-image-1", tool.Get("model").String())
	}
}

func TestBuildCodexImagesEditResponsesBody(t *testing.T) {
	raw := []byte(`{"prompt":"keep the cat, add iced tea","input_fidelity":"high","quality":"high"}`)
	body := buildCodexImagesResponsesBodyWithInputs(raw, "edit", []string{"data:image/png;base64,Y2F0"}, "data:image/png;base64,bWFzaw==")

	if got := gjson.GetBytes(body, "input.0.content.1.type").String(); got != "input_image" {
		t.Fatalf("参考图输入类型 = %q", got)
	}
	if got := gjson.GetBytes(body, "input.0.content.1.image_url").String(); got != "data:image/png;base64,Y2F0" {
		t.Fatalf("参考图未带入: %q", got)
	}
	tool := gjson.GetBytes(body, "tools.0")
	if tool.Get("action").String() != "edit" {
		t.Fatalf("edit 工具参数不对: %s", tool.Raw)
	}
	if tool.Get("input_fidelity").Exists() {
		t.Fatalf("gpt-image-2-codex 不支持 input_fidelity，不应透传: %s", tool.Raw)
	}
	if got := tool.Get("input_image_mask.image_url").String(); got != "data:image/png;base64,bWFzaw==" {
		t.Fatalf("mask 未带入: %q", got)
	}
}

// 缺 model 时工具回落默认 gpt-image-2。
func TestBuildCodexImageTool_DefaultModel(t *testing.T) {
	tool := buildCodexImageTool([]byte(`{"prompt":"x"}`))
	if gjson.GetBytes(tool, "model").String() != codexImageToolModel {
		t.Fatalf("缺 model 应回落 %q, got %s", codexImageToolModel, tool)
	}
}

// 图像模型解析:请求带 model 用它,否则默认 gpt-image-2(日志/计量用这个,不是主持人 mini)。
func TestCodexResolveImageModel(t *testing.T) {
	if got := codexResolveImageModel([]byte(`{"prompt":"x"}`)); got != codexImageToolModel {
		t.Fatalf("缺 model 应默认 %q, got %q", codexImageToolModel, got)
	}
	if got := codexResolveImageModel([]byte(`{"prompt":"x","model":"gpt-image-1"}`)); got != "gpt-image-1" {
		t.Fatalf("应用请求里的 model, got %q", got)
	}
	if codexResolveImageModel(nil) == codexImagesMainModel {
		t.Fatal("图像模型不应是主持人模型 gpt-5.4-mini")
	}
}

// 从 response.completed 抽出 base64 图片。
func TestExtractCodexImagesFromCompleted(t *testing.T) {
	completed := `{"type":"response.completed","response":{"output":[
		{"type":"reasoning","summary":[]},
		{"type":"image_generation_call","result":"iVBORw0KGgoAAAA","output_format":"png","revised_prompt":"a cat"}
	]}}`
	imgs := extractCodexImagesFromCompleted([]byte(completed))
	if len(imgs) != 1 {
		t.Fatalf("应抽出 1 张图, got %d", len(imgs))
	}
	if imgs[0].B64 != "iVBORw0KGgoAAAA" || imgs[0].OutputFormat != "png" || imgs[0].RevisedPrompt != "a cat" {
		t.Fatalf("抽出的图不对: %+v", imgs[0])
	}
}

// 非 completed 事件 / 无图 → 空。
func TestExtractCodexImages_NoneWhenNotCompleted(t *testing.T) {
	if imgs := extractCodexImagesFromCompleted([]byte(`{"type":"response.output_text.delta","delta":"hi"}`)); imgs != nil {
		t.Fatalf("非 completed 应返回 nil, got %v", imgs)
	}
	if imgs := extractCodexImagesFromCompleted([]byte(`{"type":"response.completed","response":{"output":[{"type":"message"}]}}`)); len(imgs) != 0 {
		t.Fatalf("无生图输出应为空, got %v", imgs)
	}
}

// tool_usage 计量:图像路径的用量也从 tool_usage.image_gen 折进计费(复用 codexUsageFromJSON)。
func TestCodexImagesUsageMetering(t *testing.T) {
	completed := `{"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":10,"total_tokens":40},"tool_usage":{"image_gen":{"input_tokens":0,"output_tokens":500}}}}`
	in, out, _, tot, ok := codexUsageFromJSON([]byte(completed))
	if !ok || in != 30 || out != 510 || tot != 540 {
		t.Fatalf("图像用量计费不对: in=%d out=%d tot=%d ok=%v (want 30/510/540/true)", in, out, tot, ok)
	}
}

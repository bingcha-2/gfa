package main

import (
	"bytes"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// 远程租号生图 —— 图像接口翻译(对齐 cockpit codex_openai_images.go)。
//
// Codex 的生图技能调的是 OpenAI **REST 图像接口** /v1/images/generations(需 API key),
// 而 chatgpt.com 的 codex 后端**没有**这个 REST 接口(实测只回网页 HTML)。真正能出图的是
// /backend-api/codex/responses + hosted image_generation 工具。所以正确做法不是往正常请求里
// 注入(那会打断聊天),而是**只在图像接口这一个入口**把 REST 请求翻译成 responses 内联生图
// 调用,拿到图再翻回图像接口 JSON。此翻译只作用于 /v1/images/*,绝不碰正常 /v1/responses。

const (
	// 生图 responses 请求用的主模型(对齐 cockpit codexOpenAIImagesMainModel)。
	codexImagesMainModel = "gpt-5.4-mini"
	// 生图工具默认 model(对齐 cockpit codexDefaultImageToolModel)。
	codexImageToolModel = "gpt-image-2"
)

// codexResolveImageModel 返回真正画图的模型:请求里带的 model,否则默认 gpt-image-2。
// 这才是生图归属/展示该用的模型(responses 的 gpt-5.4-mini 只是触发工具的"主持人")。
func codexResolveImageModel(rawJSON []byte) string {
	if m := strings.TrimSpace(gjson.GetBytes(rawJSON, "model").String()); m != "" {
		return m
	}
	return codexImageToolModel
}

// buildCodexImageTool 从 /v1/images/generations 的 JSON 构造 image_generation 工具。
func buildCodexImageTool(rawJSON []byte) []byte {
	tool := []byte(`{"type":"image_generation","action":"generate"}`)
	tool, _ = sjson.SetBytes(tool, "model", codexResolveImageModel(rawJSON))
	for _, field := range []string{"size", "quality", "background", "output_format", "moderation"} {
		if v := strings.TrimSpace(gjson.GetBytes(rawJSON, field).String()); v != "" {
			tool, _ = sjson.SetBytes(tool, field, v)
		}
	}
	for _, field := range []string{"output_compression", "partial_images"} {
		if v := gjson.GetBytes(rawJSON, field); v.Exists() && v.Type == gjson.Number {
			tool, _ = sjson.SetBytes(tool, field, v.Int())
		}
	}
	return tool
}

// buildCodexImagesResponsesBody 把 /v1/images/generations 请求翻译成 codex responses body
//(内联 image_generation 工具 + tool_choice 强制生图)。
func buildCodexImagesResponsesBody(rawJSON []byte) []byte {
	prompt := strings.TrimSpace(gjson.GetBytes(rawJSON, "prompt").String())
	tool := buildCodexImageTool(rawJSON)

	body := []byte(`{"instructions":"","stream":true,"reasoning":{"effort":"medium","summary":"auto"},"parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"store":false,"tool_choice":{"type":"image_generation"}}`)
	body, _ = sjson.SetBytes(body, "model", codexImagesMainModel)

	input := []byte(`[{"type":"message","role":"user","content":[{"type":"input_text","text":""}]}]`)
	input, _ = sjson.SetBytes(input, "0.content.0.text", prompt)
	body, _ = sjson.SetRawBytes(body, "input", input)
	body, _ = sjson.SetRawBytes(body, "tools", append(append([]byte("["), tool...), ']'))
	return body
}

// codexImageResult 是从 responses.completed 抽出的一张图。
type codexImageResult struct {
	B64          string
	OutputFormat string
	RevisedPrompt string
}

// scanCodexImageStream 扫完整条 responses SSE 流,抽出生成的图片。图片 b64 可能出现在
// response.output_item.done(image_generation_call.result)或 response.completed 的 output 里;
// 都拿不到时回退到最后一帧 partial_image。返回图片列表 + completed 事件原文(供计量)。
func scanCodexImageStream(data []byte) (images []codexImageResult, completed []byte) {
	var lastPartial string
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		ev := bytes.TrimSpace(line[len("data:"):])
		if len(ev) == 0 || ev[0] != '{' {
			continue
		}
		switch gjson.GetBytes(ev, "type").String() {
		case "response.image_generation_call.partial_image":
			if b := gjson.GetBytes(ev, "partial_image_b64").String(); b != "" {
				lastPartial = b
			}
		case "response.output_item.done":
			item := gjson.GetBytes(ev, "item")
			if item.Get("type").String() == "image_generation_call" {
				if res := strings.TrimSpace(item.Get("result").String()); res != "" {
					images = append(images, codexImageResult{
						B64:           res,
						OutputFormat:  strings.TrimSpace(item.Get("output_format").String()),
						RevisedPrompt: strings.TrimSpace(item.Get("revised_prompt").String()),
					})
				}
			}
		case "response.completed", "response.done":
			completed = append([]byte(nil), ev...)
			if got := extractCodexImagesFromCompleted(ev); len(got) > 0 {
				images = got
			}
		}
	}
	if len(images) == 0 && lastPartial != "" {
		images = []codexImageResult{{B64: lastPartial, OutputFormat: "png"}}
	}
	return images, completed
}

// extractCodexImagesFromCompleted 从 response.completed/response.done 事件里抽出生成的图片
//(response.output[].image_generation_call.result 是 base64)。
func extractCodexImagesFromCompleted(completedData []byte) []codexImageResult {
	t := gjson.GetBytes(completedData, "type").String()
	if t != "response.completed" && t != "response.done" {
		return nil
	}
	var out []codexImageResult
	output := gjson.GetBytes(completedData, "response.output")
	if !output.IsArray() {
		return nil
	}
	for _, item := range output.Array() {
		if item.Get("type").String() != "image_generation_call" {
			continue
		}
		res := strings.TrimSpace(item.Get("result").String())
		if res == "" {
			continue
		}
		out = append(out, codexImageResult{
			B64:           res,
			OutputFormat:  strings.TrimSpace(item.Get("output_format").String()),
			RevisedPrompt: strings.TrimSpace(item.Get("revised_prompt").String()),
		})
	}
	return out
}

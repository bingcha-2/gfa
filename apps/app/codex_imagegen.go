package main

import (
	"fmt"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// 远程租号生图:往 codex /v1/responses 请求体注入 hosted `image_generation` 工具,
// 让模型在对话回合内联生图(对齐 cockpit ensureImageGenerationTool)。远程链路此前
// 只透传 /v1/images/*(实测该端点在 chatgpt.com 不存在、只回 HTML),故内联工具注入
// 是远程用户唯一可行的生图路径。
//
// 三个跳过/冲突规则(与 cockpit 一致):
//   - *spark 模型:上游拒绝生图工具(实测 400),跳过不注入。
//   - free 套餐:免费号不支持,跳过。
//   - 客户端已自带 image_gen 函数工具:反删 hosted 工具避冲突(否则上游报重复工具)。

var codexImageGenToolJSON = []byte(`{"type":"image_generation","output_format":"png"}`)
var codexImageGenToolArrayJSON = []byte(`[{"type":"image_generation","output_format":"png"}]`)

func isCodexImageGenFunctionName(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), "image_gen.imagegen")
}

// codexToolConflictsWithHostedImageGeneration 判断某工具是否与 hosted image_generation 冲突
//(客户端自带 image_gen / image_gen.imagegen 函数)。
func codexToolConflictsWithHostedImageGeneration(tool gjson.Result) bool {
	if isCodexImageGenFunctionName(tool.Get("name").String()) || isCodexImageGenFunctionName(tool.Get("function.name").String()) {
		return true
	}
	if !strings.EqualFold(strings.TrimSpace(tool.Get("name").String()), "image_gen") {
		return false
	}
	children := tool.Get("tools")
	if !children.IsArray() {
		return false
	}
	for _, child := range children.Array() {
		if strings.EqualFold(strings.TrimSpace(child.Get("name").String()), "imagegen") ||
			strings.EqualFold(strings.TrimSpace(child.Get("function.name").String()), "imagegen") {
			return true
		}
	}
	return false
}

// removeHostedImageGenerationForFunctionConflict 删掉 hosted image_generation 工具及其 tool_choice。
func removeHostedImageGenerationForFunctionConflict(body []byte, tools gjson.Result) []byte {
	toolItems := tools.Array()
	for index := len(toolItems) - 1; index >= 0; index-- {
		if toolItems[index].Get("type").String() != "image_generation" {
			continue
		}
		body, _ = sjson.DeleteBytes(body, fmt.Sprintf("tools.%d", index))
	}
	toolChoice := gjson.GetBytes(body, "tool_choice")
	if toolChoice.String() == "image_generation" ||
		toolChoice.Get("type").String() == "image_generation" ||
		(toolChoice.Get("type").String() == "tool" && toolChoice.Get("name").String() == "image_generation") {
		body, _ = sjson.DeleteBytes(body, "tool_choice")
	}
	return body
}

// ensureCodexImageGenerationTool 按需往 responses body 注入 hosted 生图工具。
// modelKey = 最终发上游的模型(*spark 跳过);planType = 租约带回的真实号 plan(free 跳过)。
func ensureCodexImageGenerationTool(body []byte, modelKey, planType string) []byte {
	if strings.HasSuffix(strings.TrimSpace(modelKey), "spark") {
		return body
	}
	if strings.EqualFold(strings.TrimSpace(planType), "free") {
		return body
	}

	tools := gjson.GetBytes(body, "tools")
	if !tools.Exists() || !tools.IsArray() {
		body, _ = sjson.SetRawBytes(body, "tools", codexImageGenToolArrayJSON)
		return body
	}
	hasFunctionConflict := false
	hasHosted := false
	for _, t := range tools.Array() {
		if codexToolConflictsWithHostedImageGeneration(t) {
			hasFunctionConflict = true
		}
		if t.Get("type").String() == "image_generation" {
			hasHosted = true
		}
	}
	if hasFunctionConflict {
		return removeHostedImageGenerationForFunctionConflict(body, tools)
	}
	if hasHosted {
		return body
	}
	body, _ = sjson.SetRawBytes(body, "tools.-1", codexImageGenToolJSON)
	return body
}

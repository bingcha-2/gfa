package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ─── 通用 OpenAI 中转:Codex responses ⇆ chat/completions 双向转码 ──────────────
//
// 背景:Codex(provider 模式 wire_api=responses)发出的是 responses 协议请求,只能
// 直连讲 responses 的中转(serveRelayGeneration 的 responses 分支)。要接「只有
// /v1/chat/completions」的通用 OpenAI 中转,必须在客户端做双向转码:
//   请求:  responses body → chat/completions body   (convertResponsesToChatRequest)
//   响应:  chat JSON  → responses JSON               (convertChatToResponsesJSON,非流式)
//          chat SSE   → responses SSE                 (streamChatToResponses,流式)
// 字段映射对照 cockpit 的 codex↔openai 翻译器。

// relayNowUnix 返回当前 Unix 秒,用于回译响应的 created_at(单独封装便于测试)。
func relayNowUnix() int64 { return time.Now().Unix() }

// convertResponsesToChatRequest 把 Codex responses 请求体转成 chat/completions 请求体。
// model 用映射后的中转模型名覆盖;stream 决定是否注入 stream_options.include_usage。
func convertResponsesToChatRequest(body []byte, model string, stream bool) []byte {
	var root map[string]interface{}
	if err := json.Unmarshal(body, &root); err != nil {
		root = map[string]interface{}{}
	}

	out := map[string]interface{}{
		"model":  model,
		"stream": stream,
	}
	messages := make([]interface{}, 0, 8)

	// instructions → 首条 system 消息(对齐 cockpit:role 固定 system,置于最前)。
	if instr, ok := root["instructions"].(string); ok && instr != "" {
		messages = append(messages, map[string]interface{}{"role": "system", "content": instr})
	}

	// 连续的 function_call 合并进同一条 assistant 消息的 tool_calls[](对齐 cockpit),
	// 遇到任何非 function_call 项前先 flush,保证 assistant(tool_calls) 紧跟其 tool 结果。
	var pendingToolCalls []interface{}
	flushTools := func() {
		if len(pendingToolCalls) == 0 {
			return
		}
		messages = append(messages, map[string]interface{}{
			"role":       "assistant",
			"tool_calls": pendingToolCalls,
		})
		pendingToolCalls = nil
	}
	appendMessage := func(m map[string]interface{}) {
		flushTools()
		messages = append(messages, m)
	}

	// input 可能是字符串(简单单轮)或数组(多轮/带工具)。
	if s, ok := root["input"].(string); ok && s != "" {
		messages = append(messages, map[string]interface{}{"role": "user", "content": s})
	}

	if input, ok := root["input"].([]interface{}); ok {
		for _, raw := range input {
			item, _ := raw.(map[string]interface{})
			if item == nil {
				continue
			}
			switch toStr(item["type"]) {
			case "message":
				role := chatRoleFromResponses(toStr(item["role"]))
				msg := map[string]interface{}{"role": role}
				// content:数组→构造 parts 数组(text/image_url,对齐 cockpit);
				// 字符串→原样;其它→空串。
				if parts, ok := item["content"].([]interface{}); ok {
					contentArr := make([]interface{}, 0, len(parts))
					for _, p := range parts {
						part, _ := p.(map[string]interface{})
						if part == nil {
							continue
						}
						switch toStr(part["type"]) {
						case "input_text", "output_text", "text", "":
							contentArr = append(contentArr, map[string]interface{}{
								"type": "text", "text": toStr(part["text"]),
							})
						case "input_image":
							contentArr = append(contentArr, map[string]interface{}{
								"type":      "image_url",
								"image_url": map[string]interface{}{"url": toStr(part["image_url"])},
							})
						}
					}
					msg["content"] = contentArr
				} else if s, ok := item["content"].(string); ok {
					msg["content"] = s
				} else {
					msg["content"] = ""
				}
				appendMessage(msg)
			case "function_call":
				// 累积,不立即发;由后续非 function_call 项或收尾 flush 成一条 assistant。
				pendingToolCalls = append(pendingToolCalls, map[string]interface{}{
					"id":   toStr(item["call_id"]),
					"type": "function",
					"function": map[string]interface{}{
						"name":      toStr(item["name"]),
						"arguments": toStr(item["arguments"]),
					},
				})
			case "function_call_output":
				appendMessage(map[string]interface{}{
					"role":         "tool",
					"tool_call_id": toStr(item["call_id"]),
					"content":      toStr(item["output"]),
				})
			case "reasoning":
				// chat/completions 无对应,丢弃(对齐 cockpit)。
			}
		}
	}
	flushTools() // 收尾:末尾若还有未 flush 的 tool_calls。
	out["messages"] = messages

	// tools:扁平(responses)→ 嵌套(chat)。
	if tools, ok := root["tools"].([]interface{}); ok {
		outTools := make([]interface{}, 0, len(tools))
		for _, raw := range tools {
			tool, _ := raw.(map[string]interface{})
			if tool == nil || toStr(tool["type"]) != "function" {
				continue
			}
			fn := map[string]interface{}{"name": toStr(tool["name"])}
			if d, ok := tool["description"]; ok {
				fn["description"] = d
			}
			if p, ok := tool["parameters"]; ok {
				fn["parameters"] = p
			}
			outTools = append(outTools, map[string]interface{}{"type": "function", "function": fn})
		}
		if len(outTools) > 0 {
			out["tools"] = outTools
		}
	}
	if tc, ok := root["tool_choice"]; ok {
		out["tool_choice"] = tc
	}

	// max_output_tokens → max_tokens(对齐 cockpit:转 int)。
	if mt, ok := root["max_output_tokens"]; ok {
		out["max_tokens"] = toInt64(mt)
	}
	// parallel_tool_calls 透传(对齐 cockpit:存在才发,不注入默认值)。
	if pt, ok := root["parallel_tool_calls"]; ok {
		out["parallel_tool_calls"] = pt
	}
	// temperature / top_p / text.* / response_format / metadata / store 等不转发
	//(对齐 cockpit:它只 touch 上述字段)。
	//
	// reasoning.effort → reasoning_effort:cockpit 在 translator 里总是发,但管线
	// 上游用 StripThinkingConfig 按模型注册表把不支持推理的模型的 reasoning_effort
	// 砍掉。我们没有完整注册表,用模型名前缀近似(o1/o3/o4/gpt-5/codex 才发),
	// 端到端行为等价。
	if modelSupportsReasoning(model) {
		if r, ok := root["reasoning"].(map[string]interface{}); ok {
			if eff := strings.ToLower(strings.TrimSpace(toStr(r["effort"]))); eff != "" {
				out["reasoning_effort"] = eff
			}
		}
	}
	// stream 直接置;不注入 stream_options(对齐 cockpit:它不设)。中转模式不计额度,
	// 流式 usage 缺失也无妨(streamChatToResponses 拿不到就回 0)。
	out["stream"] = stream

	b, _ := json.Marshal(out)
	return b
}

// modelSupportsReasoning 近似 cockpit 的"模型是否支持推理"注册表查询:仅这些
// 系列接受 reasoning_effort。映射后的目标模型名命中前缀(忽略 provider/ 前缀与
// 大小写)才返回 true;其余(豆包、claude、通用 chat 模型等)一律不发,避免 400。
func modelSupportsReasoning(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	// 去掉 "provider/" 前缀(如 volcengine/xxx、openai/o3-mini)。
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	for _, p := range []string{"o1", "o3", "o4", "gpt-5", "codex"} {
		if strings.HasPrefix(m, p) {
			return true
		}
	}
	return false
}

// chatRoleFromResponses 把 input[] 消息项的 role 映射到 chat/completions 合法 role。
// 对齐 cockpit:developer→user(注意不是 system —— instructions 才走 system),
// system/user/assistant/tool 原样;其余未知 role 兜底 user(cockpit 原样透传,我们
// 更保守以防非法 role 触发上游 400)。
func chatRoleFromResponses(role string) string {
	switch role {
	case "developer":
		return "user"
	case "system", "user", "assistant", "tool":
		return role
	default:
		return "user"
	}
}

// convertChatToResponsesJSON 把非流式 chat/completions 响应转成 responses 对象。
func convertChatToResponsesJSON(chatBody []byte, model string, created int64) []byte {
	var chat map[string]interface{}
	_ = json.Unmarshal(chatBody, &chat)

	output := make([]interface{}, 0, 2)
	if choices, ok := chat["choices"].([]interface{}); ok && len(choices) > 0 {
		ch, _ := choices[0].(map[string]interface{})
		msg, _ := ch["message"].(map[string]interface{})
		if msg != nil {
			if content := toStr(msg["content"]); content != "" {
				output = append(output, map[string]interface{}{
					"type":    "message",
					"id":      newRespItemID(),
					"status":  "completed",
					"role":    "assistant",
					"content": []interface{}{map[string]interface{}{"type": "output_text", "text": content}},
				})
			}
			if tcs, ok := msg["tool_calls"].([]interface{}); ok {
				for _, raw := range tcs {
					tc, _ := raw.(map[string]interface{})
					if tc == nil {
						continue
					}
					fn, _ := tc["function"].(map[string]interface{})
					output = append(output, map[string]interface{}{
						"type":      "function_call",
						"id":        newRespItemID(),
						"call_id":   toStr(tc["id"]),
						"name":      toStr(fnField(fn, "name")),
						"arguments": toStr(fnField(fn, "arguments")),
					})
				}
			}
		}
	}

	resp := map[string]interface{}{
		"id":         newRespID(),
		"object":     "response",
		"created_at": created,
		"model":      model,
		"status":     "completed",
		"output":     output,
	}
	if u := mapChatUsage(chat["usage"]); u != nil {
		resp["usage"] = u
	}
	b, _ := json.Marshal(resp)
	return b
}

// streamChatToResponses 读取 chat/completions SSE 流,改写成 Codex responses SSE 事件
// 序列写入 w。返回最终 usage(input/output/total)。w 若实现 http.Flusher 则逐帧 flush。
//
// 发出的事件序列(对照 cockpit codex↔openai 响应翻译器):
//
//	response.created
//	[有文本时] output_item.added → content_part.added → output_text.delta… →
//	          output_text.done → content_part.done → output_item.done
//	[每个工具调用] output_item.added → function_call_arguments.delta →
//	          function_call_arguments.done → output_item.done
//	response.completed (携带 usage)
func streamChatToResponses(w io.Writer, r io.Reader, model string, created int64) (int64, int64, int64, error) {
	flusher, _ := w.(http.Flusher)
	respID := newRespID()
	itemBase := "msg_" + strconv.FormatUint(atomic.AddUint64(&respItemSeq, 1), 10)
	itemSeq := 0
	outputIdx := 0
	nextItemID := func() string {
		itemSeq++
		return itemBase + "_" + strconv.Itoa(itemSeq)
	}
	nextOutputIdx := func() int {
		i := outputIdx
		outputIdx++
		return i
	}

	write := func(event string, payload map[string]interface{}) {
		b, _ := json.Marshal(payload)
		_, _ = io.WriteString(w, "event: "+event+"\ndata: ")
		_, _ = w.Write(b)
		_, _ = io.WriteString(w, "\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}

	// response.created
	write(eventRespCreated, map[string]interface{}{
		"type": eventRespCreated,
		"response": map[string]interface{}{
			"id": respID, "object": "response", "created_at": created,
			"model": model, "status": "in_progress", "output": []interface{}{},
		},
	})

	var textBuf strings.Builder
	var textItemID string
	var textIdx int
	textOpen := false
	type toolAccum struct {
		id, name string
		args     strings.Builder
	}
	tools := map[int]*toolAccum{}
	var toolOrder []int
	var inTok, outTok, totTok int64

	openText := func() {
		textIdx = nextOutputIdx()
		textItemID = nextItemID()
		textOpen = true
		write(eventOutputItemAdded, map[string]interface{}{
			"type": eventOutputItemAdded, "output_index": textIdx,
			"item": map[string]interface{}{
				"type": "message", "id": textItemID, "status": "in_progress",
				"role": "assistant", "content": []interface{}{},
			},
		})
		write(eventContentPartAdded, map[string]interface{}{
			"type": eventContentPartAdded, "output_index": textIdx, "item_id": textItemID,
			"content_index": 0, "part": map[string]interface{}{"type": "output_text", "text": ""},
		})
	}
	emitText := func(delta string) {
		if !textOpen {
			openText()
		}
		textBuf.WriteString(delta)
		write(eventOutputTextDelta, map[string]interface{}{
			"type": eventOutputTextDelta, "output_index": textIdx, "item_id": textItemID,
			"content_index": 0, "delta": delta,
		})
	}
	closeText := func() {
		if !textOpen {
			return
		}
		full := textBuf.String()
		write(eventOutputTextDone, map[string]interface{}{
			"type": eventOutputTextDone, "output_index": textIdx, "item_id": textItemID,
			"content_index": 0, "text": full,
		})
		write(eventContentPartDone, map[string]interface{}{
			"type": eventContentPartDone, "output_index": textIdx, "item_id": textItemID,
			"content_index": 0, "part": map[string]interface{}{"type": "output_text", "text": full},
		})
		write(eventOutputItemDone, map[string]interface{}{
			"type": eventOutputItemDone, "output_index": textIdx,
			"item": map[string]interface{}{
				"type": "message", "id": textItemID, "status": "completed", "role": "assistant",
				"content": []interface{}{map[string]interface{}{"type": "output_text", "text": full}},
			},
		})
		textOpen = false
	}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk map[string]interface{}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if u := mapChatUsage(chunk["usage"]); u != nil {
			inTok = toInt64(u["input_tokens"])
			outTok = toInt64(u["output_tokens"])
			totTok = toInt64(u["total_tokens"])
		}
		choices, _ := chunk["choices"].([]interface{})
		if len(choices) == 0 {
			continue
		}
		ch, _ := choices[0].(map[string]interface{})
		delta, _ := ch["delta"].(map[string]interface{})
		if delta == nil {
			continue
		}
		if c := toStr(delta["content"]); c != "" {
			emitText(c)
		}
		if tcs, ok := delta["tool_calls"].([]interface{}); ok {
			for _, raw := range tcs {
				tc, _ := raw.(map[string]interface{})
				if tc == nil {
					continue
				}
				idx := int(toInt64(tc["index"]))
				acc := tools[idx]
				if acc == nil {
					acc = &toolAccum{}
					tools[idx] = acc
					toolOrder = append(toolOrder, idx)
				}
				if id := toStr(tc["id"]); id != "" {
					acc.id = id
				}
				if fn, ok := tc["function"].(map[string]interface{}); ok {
					if n := toStr(fn["name"]); n != "" {
						acc.name = n
					}
					acc.args.WriteString(toStr(fn["arguments"]))
				}
			}
		}
	}

	closeText()

	// 工具调用四件套 + 收集到 completed.output。
	completedOutput := make([]interface{}, 0, 1+len(toolOrder))
	if textBuf.Len() > 0 {
		completedOutput = append(completedOutput, map[string]interface{}{
			"type": "message", "id": textItemID, "status": "completed", "role": "assistant",
			"content": []interface{}{map[string]interface{}{"type": "output_text", "text": textBuf.String()}},
		})
	}
	for _, idx := range toolOrder {
		acc := tools[idx]
		if acc == nil {
			continue
		}
		oidx := nextOutputIdx()
		itemID := nextItemID()
		args := acc.args.String()
		write(eventOutputItemAdded, map[string]interface{}{
			"type": eventOutputItemAdded, "output_index": oidx,
			"item": map[string]interface{}{
				"type": "function_call", "id": itemID, "status": "in_progress",
				"call_id": acc.id, "name": acc.name, "arguments": "",
			},
		})
		write(eventFuncArgsDelta, map[string]interface{}{
			"type": eventFuncArgsDelta, "output_index": oidx, "item_id": itemID, "delta": args,
		})
		write(eventFuncArgsDone, map[string]interface{}{
			"type": eventFuncArgsDone, "output_index": oidx, "item_id": itemID, "arguments": args,
		})
		write(eventOutputItemDone, map[string]interface{}{
			"type": eventOutputItemDone, "output_index": oidx,
			"item": map[string]interface{}{
				"type": "function_call", "id": itemID, "status": "completed",
				"call_id": acc.id, "name": acc.name, "arguments": args,
			},
		})
		completedOutput = append(completedOutput, map[string]interface{}{
			"type": "function_call", "id": itemID, "status": "completed",
			"call_id": acc.id, "name": acc.name, "arguments": args,
		})
	}

	resp := map[string]interface{}{
		"id": respID, "object": "response", "created_at": created,
		"model": model, "status": "completed", "output": completedOutput,
	}
	if totTok > 0 || inTok > 0 || outTok > 0 {
		resp["usage"] = map[string]interface{}{
			"input_tokens": inTok, "output_tokens": outTok, "total_tokens": totTok,
		}
	}
	write(eventRespCompleted, map[string]interface{}{"type": eventRespCompleted, "response": resp})

	if err := scanner.Err(); err != nil {
		return inTok, outTok, totTok, err
	}
	return inTok, outTok, totTok, nil
}

// Codex(responses)SSE 事件名。
const (
	eventRespCreated      = "response.created"
	eventOutputItemAdded  = "response.output_item.added"
	eventContentPartAdded = "response.content_part.added"
	eventOutputTextDelta  = "response.output_text.delta"
	eventOutputTextDone   = "response.output_text.done"
	eventContentPartDone  = "response.content_part.done"
	eventOutputItemDone   = "response.output_item.done"
	eventFuncArgsDelta    = "response.function_call_arguments.delta"
	eventFuncArgsDone     = "response.function_call_arguments.done"
	eventRespCompleted    = "response.completed"
)

var (
	respSeq     uint64
	respItemSeq uint64
)

func newRespID() string { return "resp_" + strconv.FormatUint(atomic.AddUint64(&respSeq, 1), 10) }
func newRespItemID() string {
	return "msg_" + strconv.FormatUint(atomic.AddUint64(&respItemSeq, 1), 10)
}

// mapChatUsage 把 chat usage(prompt/completion/total)映射为 responses usage
// (input/output/total)。nil/缺失返回 nil。
func mapChatUsage(raw interface{}) map[string]interface{} {
	u, ok := raw.(map[string]interface{})
	if !ok || u == nil {
		return nil
	}
	return map[string]interface{}{
		"input_tokens":  toInt64(u["prompt_tokens"]),
		"output_tokens": toInt64(u["completion_tokens"]),
		"total_tokens":  toInt64(u["total_tokens"]),
	}
}

func toStr(v interface{}) string {
	s, _ := v.(string)
	return s
}

func toInt64(v interface{}) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}

func fnField(fn map[string]interface{}, key string) interface{} {
	if fn == nil {
		return ""
	}
	return fn[key]
}

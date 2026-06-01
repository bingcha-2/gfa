package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── 请求转换:Codex responses → OpenAI chat/completions ───────────────────────

func TestConvertResponsesToChatRequest(t *testing.T) {
	body := []byte(`{
		"model": "ignored-here",
		"instructions": "You are helpful.",
		"input": [
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi "},{"type":"input_text","text":"there"}]},
			{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"sf\"}"},
			{"type":"function_call_output","call_id":"call_1","output":"sunny"},
			{"type":"reasoning","summary":[]}
		],
		"tools": [
			{"type":"function","name":"get_weather","description":"get weather","parameters":{"type":"object"}}
		],
		"tool_choice": "auto",
		"max_output_tokens": 256,
		"temperature": 0.5,
		"top_p": 0.9,
		"parallel_tool_calls": true,
		"reasoning": {"effort":"high"},
		"stream": true
	}`)

	out := convertResponsesToChatRequest(body, "claude-via-relay", true)

	var got map[string]interface{}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output not valid JSON: %v\n%s", err, out)
	}

	if got["model"] != "claude-via-relay" {
		t.Fatalf("model = %v, want claude-via-relay", got["model"])
	}
	if got["stream"] != true {
		t.Fatalf("stream = %v, want true", got["stream"])
	}
	// max_output_tokens → max_tokens,转 int(对齐 cockpit)。
	if got["max_tokens"] != float64(256) {
		t.Fatalf("max_tokens = %v, want 256", got["max_tokens"])
	}
	// 非推理模型不发 reasoning_effort。
	if _, ok := got["reasoning_effort"]; ok {
		t.Fatalf("非推理模型不应转发 reasoning_effort, got %v", got["reasoning_effort"])
	}
	// temperature / top_p 一律不转发(对齐 cockpit)。
	if _, ok := got["temperature"]; ok {
		t.Fatalf("temperature 不应转发, got %v", got["temperature"])
	}
	if _, ok := got["top_p"]; ok {
		t.Fatalf("top_p 不应转发, got %v", got["top_p"])
	}
	// 不注入 stream_options(对齐 cockpit)。
	if _, ok := got["stream_options"]; ok {
		t.Fatalf("不应注入 stream_options, got %v", got["stream_options"])
	}
	// parallel_tool_calls 透传(对齐 cockpit)。
	if got["parallel_tool_calls"] != true {
		t.Fatalf("parallel_tool_calls 应透传, got %v", got["parallel_tool_calls"])
	}

	msgs, ok := got["messages"].([]interface{})
	if !ok || len(msgs) != 4 {
		t.Fatalf("messages 应有 4 条, got %v", got["messages"])
	}
	sys := msgs[0].(map[string]interface{})
	if sys["role"] != "system" || sys["content"] != "You are helpful." {
		t.Fatalf("instructions→system 映射错误, got %v", sys)
	}
	// content 应构造为 parts 数组(对齐 cockpit),两段 input_text → 两个 text part。
	user := msgs[1].(map[string]interface{})
	if user["role"] != "user" {
		t.Fatalf("user role 错误, got %v", user)
	}
	parts, ok := user["content"].([]interface{})
	if !ok || len(parts) != 2 {
		t.Fatalf("content 应为 2 段 parts 数组, got %v", user["content"])
	}
	p0 := parts[0].(map[string]interface{})
	if p0["type"] != "text" || p0["text"] != "hi " {
		t.Fatalf("part0 映射错误, got %v", p0)
	}
	asst := msgs[2].(map[string]interface{})
	tcs, _ := asst["tool_calls"].([]interface{})
	if asst["role"] != "assistant" || len(tcs) != 1 {
		t.Fatalf("assistant 应带 tool_calls, got %v", asst)
	}
	tc0 := tcs[0].(map[string]interface{})
	fn := tc0["function"].(map[string]interface{})
	if tc0["id"] != "call_1" || tc0["type"] != "function" || fn["name"] != "get_weather" || fn["arguments"] != `{"city":"sf"}` {
		t.Fatalf("function_call 映射错误, got %v", tc0)
	}
	tool := msgs[3].(map[string]interface{})
	if tool["role"] != "tool" || tool["tool_call_id"] != "call_1" || tool["content"] != "sunny" {
		t.Fatalf("function_call_output→tool 映射错误, got %v", tool)
	}

	tools, _ := got["tools"].([]interface{})
	if len(tools) != 1 {
		t.Fatalf("tools 应有 1 个, got %v", got["tools"])
	}
	tl0 := tools[0].(map[string]interface{})
	tf := tl0["function"].(map[string]interface{})
	if tl0["type"] != "function" || tf["name"] != "get_weather" || tf["description"] != "get weather" {
		t.Fatalf("tool 扁平→嵌套 映射错误, got %v", tl0)
	}
	if got["tool_choice"] != "auto" {
		t.Fatalf("tool_choice 应透传, got %v", got["tool_choice"])
	}
}

func TestConvertResponsesToChatRequestNonStream(t *testing.T) {
	out := convertResponsesToChatRequest([]byte(`{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`), "m", false)
	var got map[string]interface{}
	_ = json.Unmarshal(out, &got)
	if got["stream"] != false {
		t.Fatalf("stream = %v, want false", got["stream"])
	}
	if _, ok := got["stream_options"]; ok {
		t.Fatalf("非流式不应有 stream_options, got %v", got["stream_options"])
	}
}

// input[] 里的 developer role → user(对齐 cockpit;注意 instructions 才走 system)。
func TestConvertResponsesToChatRequestRoleMapping(t *testing.T) {
	body := []byte(`{
		"input": [
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"sys"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}
		]
	}`)
	out := convertResponsesToChatRequest(body, "m", false)
	var got map[string]interface{}
	_ = json.Unmarshal(out, &got)
	msgs := got["messages"].([]interface{})
	if len(msgs) != 2 {
		t.Fatalf("messages 应有 2 条, got %v", msgs)
	}
	if msgs[0].(map[string]interface{})["role"] != "user" {
		t.Fatalf("developer 应映射为 user(对齐 cockpit), got %v", msgs[0])
	}
	if msgs[1].(map[string]interface{})["role"] != "user" {
		t.Fatalf("user 应保持, got %v", msgs[1])
	}
}

// 连续的 function_call 应合并进同一条 assistant.tool_calls[](对齐 cockpit),
// 而不是各发一条 assistant 消息。
func TestConvertResponsesToChatRequestBatchesToolCalls(t *testing.T) {
	body := []byte(`{
		"input": [
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
			{"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},
			{"type":"function_call","call_id":"c2","name":"b","arguments":"{}"},
			{"type":"function_call_output","call_id":"c1","output":"ra"},
			{"type":"function_call_output","call_id":"c2","output":"rb"}
		]
	}`)
	out := convertResponsesToChatRequest(body, "m", false)
	var got map[string]interface{}
	_ = json.Unmarshal(out, &got)
	msgs := got["messages"].([]interface{})
	// user + 一条合并的 assistant(2 tool_calls) + 2 条 tool = 4 条。
	if len(msgs) != 4 {
		t.Fatalf("messages 应为 4 条(含 1 条合并 assistant), got %d: %v", len(msgs), msgs)
	}
	asst := msgs[1].(map[string]interface{})
	tcs, _ := asst["tool_calls"].([]interface{})
	if asst["role"] != "assistant" || len(tcs) != 2 {
		t.Fatalf("两个 function_call 应合并进一条 assistant 的 tool_calls, got %v", asst)
	}
	if msgs[2].(map[string]interface{})["role"] != "tool" || msgs[3].(map[string]interface{})["role"] != "tool" {
		t.Fatalf("两条 tool 结果应紧随, got %v / %v", msgs[2], msgs[3])
	}
}

// reasoning_effort 仅对支持推理的目标模型转发(对齐 cockpit 的模型感知 strip)。
func TestConvertResponsesToChatRequestReasoningByModel(t *testing.T) {
	body := []byte(`{"reasoning":{"effort":"high"},"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`)

	// 推理系列(gpt-5/o3 等,含 provider/ 前缀)→ 应发 reasoning_effort。
	for _, model := range []string{"gpt-5-codex", "o3-mini", "openai/o1", "gpt-5"} {
		var got map[string]interface{}
		_ = json.Unmarshal(convertResponsesToChatRequest(body, model, false), &got)
		if got["reasoning_effort"] != "high" {
			t.Fatalf("model=%s 应发 reasoning_effort=high, got %v", model, got["reasoning_effort"])
		}
	}

	// 非推理模型(豆包/claude/通用)→ 不应发,避免 litellm 400。
	for _, model := range []string{"volcengine/doubao-seed-1-6-251015", "claude-sonnet-4", "gpt-4o", "deepseek-chat"} {
		var got map[string]interface{}
		_ = json.Unmarshal(convertResponsesToChatRequest(body, model, false), &got)
		if _, ok := got["reasoning_effort"]; ok {
			t.Fatalf("model=%s 不应发 reasoning_effort, got %v", model, got["reasoning_effort"])
		}
	}
}

func TestConvertResponsesToChatRequestStringInput(t *testing.T) {
	out := convertResponsesToChatRequest([]byte(`{"input":"hello there"}`), "m", false)
	var got map[string]interface{}
	_ = json.Unmarshal(out, &got)
	msgs, _ := got["messages"].([]interface{})
	if len(msgs) != 1 || msgs[0].(map[string]interface{})["role"] != "user" || msgs[0].(map[string]interface{})["content"] != "hello there" {
		t.Fatalf("字符串 input 应转成单条 user 消息, got %v", got["messages"])
	}
}

// ─── 非流式响应转换:chat/completions JSON → Codex responses JSON ───────────────

func TestConvertChatToResponsesJSON(t *testing.T) {
	chat := []byte(`{
		"id":"chatcmpl-1","object":"chat.completion","model":"upstream-model",
		"choices":[{"index":0,"message":{"role":"assistant","content":"Hello!"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
	}`)
	out := convertChatToResponsesJSON(chat, "gpt-5-codex", 1700000000)

	var got map[string]interface{}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output not valid JSON: %v\n%s", err, out)
	}
	if got["object"] != "response" || got["status"] != "completed" {
		t.Fatalf("应为 object=response status=completed, got %v", got)
	}
	output, _ := got["output"].([]interface{})
	if len(output) != 1 {
		t.Fatalf("output 应有 1 个 message, got %v", got["output"])
	}
	item := output[0].(map[string]interface{})
	content := item["content"].([]interface{})
	part := content[0].(map[string]interface{})
	if item["type"] != "message" || part["type"] != "output_text" || part["text"] != "Hello!" {
		t.Fatalf("message/output_text 映射错误, got %v", item)
	}
	usage := got["usage"].(map[string]interface{})
	if usage["input_tokens"] != float64(10) || usage["output_tokens"] != float64(5) || usage["total_tokens"] != float64(15) {
		t.Fatalf("usage 映射错误, got %v", usage)
	}
}

func TestConvertChatToResponsesJSONToolCalls(t *testing.T) {
	chat := []byte(`{
		"id":"c","object":"chat.completion","model":"m",
		"choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_9","type":"function","function":{"name":"do_it","arguments":"{\"x\":1}"}}
		]},"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
	}`)
	out := convertChatToResponsesJSON(chat, "m", 1)
	var got map[string]interface{}
	_ = json.Unmarshal(out, &got)
	output := got["output"].([]interface{})
	if len(output) != 1 {
		t.Fatalf("output 应有 1 个 function_call, got %v", output)
	}
	fc := output[0].(map[string]interface{})
	if fc["type"] != "function_call" || fc["call_id"] != "call_9" || fc["name"] != "do_it" || fc["arguments"] != `{"x":1}` {
		t.Fatalf("function_call 映射错误, got %v", fc)
	}
}

// ─── 流式响应转换:chat/completions SSE → Codex responses SSE ───────────────────

func TestStreamChatToResponsesText(t *testing.T) {
	chatSSE := strings.Join([]string{
		`data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
		`data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}`,
		`data: {"choices":[{"index":0,"delta":{"content":" world"}}]}`,
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`,
		`data: [DONE]`,
		``,
	}, "\n\n")

	var buf bytes.Buffer
	in, outTok, total, err := streamChatToResponses(&buf, strings.NewReader(chatSSE), "gpt-5-codex", 1700000000)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if in != 10 || outTok != 3 || total != 13 {
		t.Fatalf("usage = (%d,%d,%d), want (10,3,13)", in, outTok, total)
	}
	s := buf.String()

	mustContainInOrder(t, s, []string{
		"event: response.created",
		"event: response.output_item.added",
		"event: response.content_part.added",
		"event: response.output_text.delta",
		"event: response.output_text.done",
		"event: response.content_part.done",
		"event: response.output_item.done",
		"event: response.completed",
	})
	if !strings.Contains(s, `"delta":"Hello"`) || !strings.Contains(s, `"delta":" world"`) {
		t.Fatalf("文本 delta 未透传:\n%s", s)
	}
	if !strings.Contains(s, `"input_tokens":10`) || !strings.Contains(s, `"output_tokens":3`) {
		t.Fatalf("completed 未携带映射 usage:\n%s", s)
	}
	if !strings.Contains(s, "event: response.created\ndata: {") {
		t.Fatalf("SSE 帧格式错误:\n%s", s)
	}
}

func TestStreamChatToResponsesToolCall(t *testing.T) {
	chatSSE := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"sf\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		``,
	}, "\n\n")

	var buf bytes.Buffer
	_, _, _, err := streamChatToResponses(&buf, strings.NewReader(chatSSE), "m", 1)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	s := buf.String()
	mustContainInOrder(t, s, []string{
		"event: response.output_item.added",
		"event: response.function_call_arguments.delta",
		"event: response.function_call_arguments.done",
		"event: response.output_item.done",
		"event: response.completed",
	})
	if !strings.Contains(s, `"name":"get_weather"`) {
		t.Fatalf("function 名未透传:\n%s", s)
	}
	if !strings.Contains(s, `"arguments":"{\"city\":\"sf\"}"`) {
		t.Fatalf("function 参数未累积完整:\n%s", s)
	}
	if !strings.Contains(s, `"call_id":"call_1"`) {
		t.Fatalf("call_id 未透传:\n%s", s)
	}
}

// ─── 集成:chat 协议中转端到端(请求转码 + 响应回译) ─────────────────────────

func TestCodexProxyRelayChatProtocolNonStream(t *testing.T) {
	var gotPath, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"Hi!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`)
	}))
	defer upstream.Close()

	proxy := &CodexProxy{relay: &CodexRelayConfig{
		BaseURL: upstream.URL, APIKey: "k", Protocol: "chat",
		ModelMap: map[string]string{"gpt-5-codex": "relay-model"},
	}}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses",
		strings.NewReader(`{"model":"gpt-5-codex","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("upstream path = %s, want /chat/completions", gotPath)
	}
	if !strings.Contains(gotBody, `"messages"`) || !strings.Contains(gotBody, `"model":"relay-model"`) {
		t.Fatalf("上游应收到 chat 格式 + 映射模型, got %s", gotBody)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应非 JSON: %v\n%s", err, rec.Body.String())
	}
	if got["object"] != "response" {
		t.Fatalf("应回译为 responses 格式, got %s", rec.Body.String())
	}
}

func TestCodexProxyRelayChatProtocolStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	proxy := &CodexProxy{relay: &CodexRelayConfig{BaseURL: upstream.URL, APIKey: "k", Protocol: "chat"}}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses",
		strings.NewReader(`{"model":"gpt-5-codex","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req, "", "device-a", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	s := rec.Body.String()
	if !strings.Contains(s, "event: response.created") || !strings.Contains(s, "event: response.completed") {
		t.Fatalf("流式响应未回译为 responses SSE:\n%s", s)
	}
	if !strings.Contains(s, `"delta":"Hi"`) {
		t.Fatalf("文本 delta 丢失:\n%s", s)
	}
}

func mustContainInOrder(t *testing.T, s string, subs []string) {
	t.Helper()
	idx := 0
	for _, sub := range subs {
		pos := strings.Index(s[idx:], sub)
		if pos < 0 {
			t.Fatalf("缺少或顺序错误: %q\n--- 完整输出 ---\n%s", sub, s)
		}
		idx += pos + len(sub)
	}
}

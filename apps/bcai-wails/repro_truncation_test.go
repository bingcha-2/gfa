package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #3-F: peekEmbeddedStreamError —— 200 内嵌错误的预读判定(给"换号"用)。
func TestFix_PeekEmbeddedStreamError(t *testing.T) {
	mk := func(body string) *http.Response {
		return &http.Response{Body: io.NopCloser(strings.NewReader(body))}
	}

	// 非流式 → 不预读
	if fc, reason, _, _ := peekEmbeddedStreamError(mk("whatever"), false); fc != nil || reason != "" {
		t.Errorf("非流式应返回空,got fc=%q reason=%q", fc, reason)
	}

	// 200 内嵌配额错误 → reason=quota,firstChunk 带出
	fc, reason, _, _ := peekEmbeddedStreamError(mk(`data: {"error":{"status":"RESOURCE_EXHAUSTED"}}`+"\n\n"), true)
	if reason != "quota" {
		t.Errorf("内嵌配额错误应判 quota,got %q", reason)
	}
	if len(fc) == 0 {
		t.Error("应回带 firstChunk 供日志/上报")
	}

	// 200 内嵌容量错误 → capacity + model
	_, reason, model, _ := peekEmbeddedStreamError(mk(`{"error":{"code":503,"message":"No capacity available for model gemini-2.5-pro","details":[{"metadata":{"model":"gemini-2.5-pro"}}]}}`), true)
	if reason != "capacity" || model != "gemini-2.5-pro" {
		t.Errorf("内嵌容量错误 got reason=%q model=%q", reason, model)
	}

	// 合法生图内容(含触发词字样)→ 干净,reason 为空,firstChunk 原样带出转发
	clean := `data: {"candidates":[{"content":{"parts":[{"text":"resource_exhausted is just a string here"}]}}]}` + "\n\n"
	fc2, reason2, _, _ := peekEmbeddedStreamError(mk(clean), true)
	if reason2 != "" {
		t.Errorf("合法内容应判干净,got %q", reason2)
	}
	if string(fc2) != clean {
		t.Errorf("干净首块应原样带出,got %q", fc2)
	}
}

// ════════════════════════════════════════════════════════════════════════════
// 问题 3 回归：代理截断流输出（工具调用 / 生图被掐断）
//
// 修复:checkStreamingQuotaError 改为【结构化判定】——只在上游返回的顶层
// error 对象({"error":{...}})里匹配,绝不扫模型正文(candidates/content/
// functionCall/inlineData)。下面这些【合法内容】里即使出现触发词,也不再被掐流。
//
// 这些用例在【修复后转绿】:断言合法内容不再被误判/截断。
// 若日后有人把 matcher 改回裸子串,这些用例会立刻 FAIL。
// ════════════════════════════════════════════════════════════════════════════

// 对照组 —— Codex / Anthropic 路径【不扫内容、不掐流】(忠实拷贝)。
func TestRepro_CodexAndClaude_DoNotTruncate(t *testing.T) {
	sse := `data: {"type":"content","text":"note: resource_exhausted handling; no capacity available message"}` + "\n\n" +
		`data: {"type":"image","inlineData":{"mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}` + "\n\n" +
		`data: [DONE]` + "\n\n"

	t.Run("codex 忠实拷贝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, _, _, _, err := copyStreamingCodexResponse(rec, strings.NewReader(sse)); err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if rec.Body.String() != sse {
			t.Errorf("codex 路径改动了内容(不该):\n got=%q", rec.Body.String())
		}
	})
	t.Run("claude 忠实拷贝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, err := copyStreamingClaudeResponse(rec, strings.NewReader(sse)); err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if rec.Body.String() != sse {
			t.Errorf("claude 路径改动了内容(不该):\n got=%q", rec.Body.String())
		}
	})
}

// #3-A: 含触发词的【合法模型内容】不再被误判(结构化后只认顶层 error)。
func TestFix_NoFalsePositive_OnLegitContent(t *testing.T) {
	legit := []struct {
		name  string
		chunk string
	}{
		{"助手解释报错含义", `data: {"candidates":[{"content":{"parts":[{"text":"当你看到 RESOURCE_EXHAUSTED 时,说明配额用尽了。"}]}}]}` + "\n\n"},
		{"工具参数含字面量", `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"write_file","args":{"content":"throw new Error('MODEL_CAPACITY_EXHAUSTED')"}}}]}}]}` + "\n\n"},
		{"生图文案含 no capacity available", `data: {"candidates":[{"content":{"parts":[{"text":"Generating image. Note: if there is no capacity available, retry later."}]}}]}` + "\n\n"},
		{"引用日志 quota reached", `data: {"candidates":[{"content":{"parts":[{"text":"The log line said: baseline model quota reached"}]}}]}` + "\n\n"},
		{"finishReason SAFETY 不是配额", `data: {"candidates":[{"finishReason":"SAFETY","content":{"parts":[]}}]}` + "\n\n"},
	}
	for _, tc := range legit {
		if reason, _, _ := checkStreamingQuotaError(tc.chunk); reason != "" {
			t.Errorf("%s: 合法内容被误判为 %q(应为空)", tc.name, reason)
		}
	}
}

// #3-B: streamResponse 不再截断【合法生图响应】(首块文字含触发词也照常转发图片)。
func TestFix_StreamResponse_KeepsLegitContent(t *testing.T) {
	p := &ProxyServer{}
	chunks := []string{
		`data: {"candidates":[{"content":{"parts":[{"text":"Here is the image. (debug note: resource_exhausted handling enabled)"}]}}]}` + "\n\n",
		`data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"iVBORw0KGgoAAAANS..."}}]}}]}` + "\n\n",
		`data: [DONE]` + "\n\n",
	}
	result := p.streamResponse(httptest.NewRecorder(), newSlowReader(chunks, nil), 1, false)
	if result.StreamError {
		t.Errorf("合法生图流被掐(StreamError=true reason=%q)", result.StreamErrorReason)
	}
}

// #3-C: 首 chunk 闸不再误杀【合法生图首块】。
func TestFix_FirstChunkGate_AllowsLegitImageStart(t *testing.T) {
	firstChunk := `data: {"candidates":[{"content":{"parts":[{"text":"I'll generate that. If the model has no capacity available right now, I'll note it."}]}],"modelVersion":"gemini-2.5-flash-image"}` + "\n\n"
	if reason, _, _ := checkStreamingQuotaError(firstChunk); reason != "" {
		t.Errorf("首 chunk 闸误杀合法生图首块:reason=%q(应为空)", reason)
	}
}

// #3-D: 真·上游错误仍必须被识别(防止"修过头"把真错误也放过)。
func TestFix_RealUpstreamError_StillDetected(t *testing.T) {
	cases := []struct {
		name       string
		chunk      string
		wantReason string
		wantModel  string
	}{
		{
			name:       "200 内嵌 quota 错误(SSE data 行)",
			chunk:      `data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"baseline model quota reached","details":[{"metadata":{"quotaResetDelay":"5h"}}]}}` + "\n\n",
			wantReason: "quota",
		},
		{
			name:       "容量错误带 model",
			chunk:      `{"error":{"code":503,"status":"UNAVAILABLE","message":"No capacity available for model gemini-2.5-pro","details":[{"metadata":{"model":"gemini-2.5-pro"}}]}}`,
			wantReason: "capacity",
			wantModel:  "gemini-2.5-pro",
		},
		{
			name:       "数组分片包裹的错误",
			chunk:      `[{"error":{"status":"RESOURCE_EXHAUSTED"}}]`,
			wantReason: "quota",
		},
		{
			name:       "错误事件夹在正常事件之后(跨事件)",
			chunk:      `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}` + "\n\n" + `data: {"error":{"status":"RESOURCE_EXHAUSTED"}}` + "\n\n",
			wantReason: "quota",
		},
	}
	for _, tc := range cases {
		reason, model, _ := checkStreamingQuotaError(tc.chunk)
		if reason != tc.wantReason {
			t.Errorf("%s: reason=%q want %q", tc.name, reason, tc.wantReason)
		}
		if tc.wantModel != "" && model != tc.wantModel {
			t.Errorf("%s: model=%q want %q", tc.name, model, tc.wantModel)
		}
	}
}

// #3-E: streamResponse 对【真·错误开头】仍硬掐 + 注入 [DONE](保持原有换号语义)。
func TestFix_StreamResponse_StillTruncatesRealErrorStart(t *testing.T) {
	p := &ProxyServer{}
	chunks := []string{`data: {"error":{"status":"RESOURCE_EXHAUSTED","message":"baseline model quota reached"}}` + "\n\n"}
	result := p.streamResponse(httptest.NewRecorder(), newSlowReader(chunks, nil), 1, false)
	if !result.StreamError || result.StreamErrorReason != "quota" {
		t.Errorf("真错误开头应被识别:StreamError=%v reason=%q", result.StreamError, result.StreamErrorReason)
	}
}

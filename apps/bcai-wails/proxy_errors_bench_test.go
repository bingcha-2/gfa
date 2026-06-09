package main

import (
	"bytes"
	"strings"
	"testing"
)

// 热路径基准:模拟流式 4KB 滑窗的两种典型 chunk。
// 关注 ns/op 和 allocs/op(B/op)。目标:常见(无错误)情形零分配、纯一次 substring 扫描。

// 4KB 正常内容(生图/工具调用),不含 JSON "error" 键 —— 占流量绝大多数。
var benchCleanWindow = []byte(`data: {"candidates":[{"content":{"parts":[{"text":"` +
	strings.Repeat("正常输出内容 some normal streamed text resource usage etc ", 60) + `"}]}}]}` + "\n\n")

// 含上游 200-内嵌配额错误的窗口(罕见)。
var benchErrorWindow = []byte(`data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"baseline model quota reached"}}` + "\n\n")

// BenchmarkHotPath_CommonChunk 复刻调用方热路径:先 Bytes() 零拷贝预判,无 "error" 键直接跳过。
func BenchmarkHotPath_CommonChunk(b *testing.B) {
	var win bytes.Buffer
	win.Write(benchCleanWindow)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if bytes.Contains(win.Bytes(), errorKeyNeedle) {
			_, _, _ = checkStreamingQuotaError(win.String())
		}
	}
}

// BenchmarkHotPath_ErrorChunk 罕见情形:命中 "error" 键 → 走结构化解析。
func BenchmarkHotPath_ErrorChunk(b *testing.B) {
	var win bytes.Buffer
	win.Write(benchErrorWindow)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if bytes.Contains(win.Bytes(), errorKeyNeedle) {
			_, _, _ = checkStreamingQuotaError(win.String())
		}
	}
}

// BenchmarkMatcherOnly_Common 仅 matcher(含其内部 "error" 快速路径)在正常内容上的成本。
func BenchmarkMatcherOnly_Common(b *testing.B) {
	s := string(benchCleanWindow)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = checkStreamingQuotaError(s)
	}
}

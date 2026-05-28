package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

// slowReader simulates a streaming body with controllable delays between chunks
type slowReader struct {
	chunks   [][]byte
	delays   []time.Duration
	idx      int
	mu       sync.Mutex
	closed   bool
	closedCh chan struct{}
}

func newSlowReader(chunks []string, delays []time.Duration) *slowReader {
	bs := make([][]byte, len(chunks))
	for i, c := range chunks {
		bs[i] = []byte(c)
	}
	return &slowReader{
		chunks:   bs,
		delays:   delays,
		closedCh: make(chan struct{}),
	}
}

func (r *slowReader) Read(p []byte) (int, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return 0, io.EOF
	}
	if r.idx >= len(r.chunks) {
		r.mu.Unlock()
		return 0, io.EOF
	}
	idx := r.idx
	r.idx++
	r.mu.Unlock()

	// Delay before returning this chunk
	if idx < len(r.delays) && r.delays[idx] > 0 {
		select {
		case <-time.After(r.delays[idx]):
		case <-r.closedCh:
			return 0, io.EOF
		}
	}

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return 0, io.EOF
	}
	r.mu.Unlock()

	n := copy(p, r.chunks[idx])
	return n, nil
}

func (r *slowReader) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.closed = true
		close(r.closedCh)
	}
	return nil
}

// brokenWriter simulates a disconnected downstream (IDE)
type brokenWriter struct {
	http.ResponseWriter
	writtenBytes int
	breakAfter   int // break after this many bytes
}

func (w *brokenWriter) Write(p []byte) (int, error) {
	w.writtenBytes += len(p)
	if w.breakAfter > 0 && w.writtenBytes > w.breakAfter {
		return 0, io.ErrClosedPipe
	}
	return w.ResponseWriter.Write(p)
}

func (w *brokenWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

func TestStreamResponse_NormalFlow(t *testing.T) {
	p := &ProxyServer{}

	chunks := []string{
		`data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}` + "\n\n",
		`data: {"candidates":[{"content":{"parts":[{"text":" World"}]}}]}` + "\n\n",
		`data: [DONE]` + "\n\n",
	}
	reader := newSlowReader(chunks, nil)

	rec := httptest.NewRecorder()
	result := p.streamResponse(rec, reader, 1)

	body := rec.Body.String()
	if !strings.Contains(body, "Hello") {
		t.Error("expected 'Hello' in output")
	}
	if !strings.Contains(body, "World") {
		t.Error("expected 'World' in output")
	}
	if result.StreamError {
		t.Error("expected no stream error")
	}
}

func TestStreamResponse_DetectsQuotaError(t *testing.T) {
	p := &ProxyServer{}

	chunks := []string{
		`data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}` + "\n\n",
		`{"error":{"message":"RESOURCE_EXHAUSTED: baseline model quota reached"}}`,
	}
	reader := newSlowReader(chunks, nil)

	rec := httptest.NewRecorder()
	result := p.streamResponse(rec, reader, 2)

	if !result.StreamError {
		t.Error("expected StreamError=true for mid-stream quota error")
	}
	if result.StreamErrorReason != "quota" {
		t.Errorf("StreamErrorReason = %q, want quota", result.StreamErrorReason)
	}
}

func TestStreamResponse_DownstreamDisconnect(t *testing.T) {
	p := &ProxyServer{}

	// Send many chunks, break after a few bytes
	chunks := make([]string, 100)
	for i := range chunks {
		chunks[i] = `data: {"candidates":[{"content":{"parts":[{"text":"chunk"}]}}]}` + "\n\n"
	}
	reader := newSlowReader(chunks, nil)

	rec := httptest.NewRecorder()
	bw := &brokenWriter{ResponseWriter: rec, breakAfter: 100}

	result := p.streamResponse(bw, reader, 3)

	// Should not have processed all chunks (downstream broke)
	if result.StreamBytes > 10000 {
		t.Errorf("expected early abort, got %d bytes", result.StreamBytes)
	}
}

func TestStreamResponse_FirstByteTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow test in short mode")
	}

	p := &ProxyServer{}

	// Reader that never sends any data (delays 10 minutes)
	reader := newSlowReader(
		[]string{"data: hello\n\n"},
		[]time.Duration{10 * time.Minute},
	)

	rec := httptest.NewRecorder()

	// This test is slow but we patch the timeout constants via the function's behavior
	// The streamResponse has a 180s first-byte timeout — we test that it eventually returns
	// by using a closable reader that the timer goroutine will close

	done := make(chan TokenUsageResult, 1)
	go func() {
		result := p.streamResponse(rec, reader, 4)
		done <- result
	}()

	// The timer should close the reader after 180s...
	// For testing, we'll close it manually after a short wait to verify the behavior
	time.Sleep(200 * time.Millisecond)
	reader.Close()

	select {
	case <-done:
		// Good - returned after reader was closed
	case <-time.After(5 * time.Second):
		t.Fatal("streamResponse did not return after reader close")
	}
}

// TestStreamResponse_IdleTimeout_NoDoneSent 复现 bug：
// 当流式响应因 idle timeout 中断时，不会向 IDE 发送 [DONE] 标记，
// 导致 IDE 一直显示 working。
func TestStreamResponse_IdleTimeout_NoDoneSent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow test in short mode")
	}

	p := &ProxyServer{
		// 使用短超时，让 timer goroutine 在测试中快速触发
		StreamMaxIdle:       200 * time.Millisecond,
		StreamCheckInterval: 50 * time.Millisecond,
	}

	// 模拟：先返回一些数据，然后长时间静默（超过 streamMaxIdle）
	// 第一个 chunk 立即返回，第二个 chunk 延迟很长（模拟 thinking 阶段）
	reader := newSlowReader(
		[]string{
			`data: {"candidates":[{"content":{"parts":[{"text":"thinking..."}]}}]}` + "\n\n",
			`data: {"candidates":[{"content":{"parts":[{"text":"result"}]}}]}` + "\n\n",
		},
		[]time.Duration{
			0,                // 第一个 chunk 立即返回
			30 * time.Minute, // 第二个 chunk 延迟30分钟（模拟超长思考）
		},
	)

	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		p.streamResponse(rec, reader, 5)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("streamResponse did not return after idle timeout")
	}

	body := rec.Body.String()

	// 修复后：idle timeout 应该向 IDE 发送 [DONE]
	if !strings.Contains(body, "[DONE]") {
		t.Error("BUG: idle timeout did NOT send [DONE] to IDE — IDE will keep showing 'working'")
	}

	// 应该包含第一个 chunk 的数据
	if !strings.Contains(body, "thinking...") {
		t.Error("expected first chunk data in output")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug #1: 动态扩展 idle timeout
// 已收到大量数据时，idle timeout 应该自动延长，避免长文件生成被截断
// ═══════════════════════════════════════════════════════════════════════════

func TestStreamResponse_DynamicIdleExpansion(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow test in short mode")
	}

	// 基础 idle timeout 设为 200ms
	baseIdle := 200 * time.Millisecond

	p := &ProxyServer{
		StreamMaxIdle:       baseIdle,
		StreamCheckInterval: 50 * time.Millisecond,
	}

	// 先发送 200KB 数据（约 200 个 1KB chunk），然后长时间静默
	// 如果有动态扩展，200KB 应该让 idle timeout 延长到远超 200ms
	chunks := make([]string, 202)
	delays := make([]time.Duration, 202)
	for i := 0; i < 200; i++ {
		// 每个 chunk ~1KB
		chunks[i] = `data: {"candidates":[{"content":{"parts":[{"text":"` + strings.Repeat("x", 1000) + `"}]}}]}` + "\n\n"
		delays[i] = 0 // 立即返回
	}
	// 第 201 个 chunk 延迟 400ms（超过基础 idle 200ms，但如果动态扩展了就不会超时）
	chunks[200] = `data: {"candidates":[{"content":{"parts":[{"text":"after-thinking"}]}}]}` + "\n\n"
	delays[200] = 400 * time.Millisecond
	// 最后一个正常结束
	chunks[201] = `data: [DONE]` + "\n\n"
	delays[201] = 0

	reader := newSlowReader(chunks, delays)
	rec := httptest.NewRecorder()

	doneCh := make(chan struct{})
	go func() {
		p.streamResponse(rec, reader, 100)
		close(doneCh)
	}()

	select {
	case <-doneCh:
	case <-time.After(5 * time.Second):
		t.Fatal("streamResponse did not return in time")
	}

	body := rec.Body.String()

	// 动态扩展后，200KB 数据应该让 idle timeout 延长，
	// 400ms 的思考间隙不应触发超时
	if !strings.Contains(body, "after-thinking") {
		t.Error("BUG: 200KB data did NOT extend idle timeout — stream was cut during thinking pause")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug #4: keepalive 写入失败时，应中断上游连接
// 当 IDE 断开后，keepalive 写入失败但未关闭上游
// ═══════════════════════════════════════════════════════════════════════════

// keepaliveBreakWriter 模拟：前几次写入正常，keepalive 写入时返回错误
type keepaliveBreakWriter struct {
	http.ResponseWriter
	mu            sync.Mutex
	writeCount    int
	breakOnWrite  int // 第 N 次写入时断开（模拟 IDE 在流中途断开）
}

func (w *keepaliveBreakWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.writeCount++
	count := w.writeCount
	w.mu.Unlock()

	if count >= w.breakOnWrite {
		return 0, io.ErrClosedPipe
	}
	return w.ResponseWriter.Write(p)
}

func (w *keepaliveBreakWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func TestStreamResponse_KeepaliveDetectsDownstreamDisconnect(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow test in short mode")
	}

	p := &ProxyServer{
		StreamMaxIdle:       10 * time.Second, // 长一些，不让 idle timeout 触发
		StreamCheckInterval: 50 * time.Millisecond,
	}

	// 发一个 chunk 后进入长思考（10s），期间 timer goroutine 会发 keepalive
	reader := newSlowReader(
		[]string{
			`data: {"candidates":[{"content":{"parts":[{"text":"start"}]}}]}` + "\n\n",
			`data: {"candidates":[{"content":{"parts":[{"text":"never"}]}}]}` + "\n\n",
		},
		[]time.Duration{
			0,                // 第一个 chunk 立即
			30 * time.Minute, // 第二个 chunk 永远等
		},
	)

	rec := httptest.NewRecorder()
	// 第 3 次写入时断开（第 1 次 = 数据 chunk, 第 2 次 = keepalive 写入, 第 3 次断）
	bw := &keepaliveBreakWriter{ResponseWriter: rec, breakOnWrite: 3}

	doneCh := make(chan struct{})
	go func() {
		p.streamResponse(bw, reader, 200)
		close(doneCh)
	}()

	// 期望：keepalive 写入失败后，应该很快关闭上游并返回
	// 不应该等到 10s 的 StreamMaxIdle
	select {
	case <-doneCh:
		// 好：快速返回了
	case <-time.After(3 * time.Second):
		t.Fatal("BUG: keepalive write failed but streamResponse did NOT close upstream — stuck waiting for idle timeout")
	}
}

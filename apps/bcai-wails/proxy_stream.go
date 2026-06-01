package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

func (p *ProxyServer) streamResponse(w http.ResponseWriter, body io.Reader, reqId int64) TokenUsageResult {
	buffer := make([]byte, 32768) // 32KB read buffer（减少系统调用，提升流式吞吐）
	// 尾部缓冲：仅保留流的最后 16KB 用于解析 token 用量（usageMetadata 只出现在末尾）
	var tailBuffer bytes.Buffer
	const tailBufferMax = 16384
	streamQuotaDetected := false

	// 滑动窗口缓冲：防止 quota 错误 JSON 被 chunk 边界切断（timo 使用 Rust async stream 无此问题）
	var recentWindow bytes.Buffer
	const recentWindowMax = 4096

	// 流式错误信息，用于通知调用方上报
	var streamErrorReason, streamErrorModel string
	var streamRetryAfterMs int64
	var totalStreamBytes atomic.Int64

	flusher, ok := w.(http.Flusher)

	// All writes to w happen from BOTH this function and the keepalive/idle timer
	// goroutine below. http.ResponseWriter is not safe for concurrent use, so every
	// write+flush must hold writeMu — otherwise the keepalive write races the body
	// copy (caught by `go test -race`). The lock is only ever held for a short write,
	// never across body.Read, so it cannot deadlock or stall the stream.
	var writeMu sync.Mutex
	writeAndFlush := func(b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err := w.Write(b)
		if ok {
			flusher.Flush()
		}
		return err
	}

	// P1⑦: Stream inactivity timer with keepalive
	const streamFirstByteTimeout = 180 * time.Second // 3 min for initial thinking
	streamMidCheckInterval := 60 * time.Second       // 60s between health checks
	const streamGracePeriod = 30 * time.Second       // 30s per grace extension
	streamMaxIdle := 5 * time.Minute                 // default max idle

	// 允许通过 ProxyServer 字段覆盖（用于测试）
	if p.StreamMaxIdle > 0 {
		streamMaxIdle = p.StreamMaxIdle
	}
	if p.StreamCheckInterval > 0 {
		streamMidCheckInterval = p.StreamCheckInterval
	}

	var streamHasData atomic.Bool
	var lastDataNano atomic.Int64
	lastDataNano.Store(time.Now().UnixNano())
	var streamTimedOut atomic.Bool

	// Timer goroutine
	done := make(chan struct{})
	defer close(done)

	go func() {
		// 统一用 ticker 检测，避免 firstByte select 阻塞导致 idle check 延迟
		ticker := time.NewTicker(streamMidCheckInterval)
		defer ticker.Stop()
		startTime := time.Now()

		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if !streamHasData.Load() {
					// 首字节超时检测
					if time.Since(startTime) >= streamFirstByteTimeout {
						streamTimedOut.Store(true)
						Log("[proxy] #%d [STREAM-TIMEOUT] First byte timeout (%ds)", reqId, int(streamFirstByteTimeout.Seconds()))
						if closer, ok := body.(io.Closer); ok {
							closer.Close()
						}
						return
					}
					continue
				}

				// Mid-stream idle 检测（动态扩展：每收到 100KB 延长 1 分钟，上限 30 分钟）
				receivedBytes := totalStreamBytes.Load()
				dynamicIdle := streamMaxIdle + time.Duration(receivedBytes/102400)*time.Minute
				if dynamicIdle > 30*time.Minute {
					dynamicIdle = 30 * time.Minute
				}

				idleDuration := time.Since(time.Unix(0, lastDataNano.Load()))
				if idleDuration >= dynamicIdle {
					streamTimedOut.Store(true)
					Log("[proxy] #%d [STREAM-TIMEOUT] Max idle %ds exceeded (dynamic=%ds, received=%dKB)",
						reqId, int(idleDuration.Seconds()), int(dynamicIdle.Seconds()), receivedBytes/1024)
					// 通知 IDE 流已结束，避免一直 working
					if ok {
						_ = writeAndFlush([]byte("\ndata: [DONE]\n\n"))
					}
					if closer, ok := body.(io.Closer); ok {
						closer.Close()
					}
					return
				}

				// Send SSE keepalive comment — 同时检测下游是否断开
				if ok && !streamTimedOut.Load() {
					writeErr := writeAndFlush([]byte(fmt.Sprintf(": bcai-keepalive %d\n\n", time.Now().UnixMilli())))
					if writeErr != nil {
						// 下游（IDE）已断开，立即关闭上游连接
						streamTimedOut.Store(true)
						Log("[proxy] #%d [STREAM] downstream disconnected during keepalive: %v", reqId, writeErr)
						if closer, ok := body.(io.Closer); ok {
							closer.Close()
						}
						return
					}
				}
				Log("[proxy] #%d [STREAM] idle %ds, socket alive, grace +%ds",
					reqId, int(idleDuration.Seconds()), int(streamGracePeriod.Seconds()))
			}
		}
	}()

	for {
		n, err := body.Read(buffer)
		if n > 0 {
			totalStreamBytes.Add(int64(n))
			_, _ = tailBuffer.Write(buffer[:n])
			if tailBuffer.Len() > tailBufferMax {
				tailBuffer.Next(tailBuffer.Len() - tailBufferMax)
			}
			streamHasData.Store(true)
			lastDataNano.Store(time.Now().UnixNano())

			// 更新滑动窗口（用于跨 chunk 检测）
			recentWindow.Write(buffer[:n])
			if recentWindow.Len() > recentWindowMax {
				recentWindow.Next(recentWindow.Len() - recentWindowMax)
			}

			// [TIMO-STYLE] 检测 mid-stream quota/capacity 错误
			// timo 检测到后：中断流 + toast 通知 + 换号重试
			// 插件检测到后：proxyRes.destroy() + res.end() + reportRemoteResult
			// 我们参照两者：中断上游 + 停止转发 + 通知调用方上报
			if !streamQuotaDetected {
				if reason, modelKey, retryAfterMs := checkStreamingQuotaError(recentWindow.String()); reason != "" {
					streamQuotaDetected = true
					streamErrorReason = reason
					streamErrorModel = modelKey
					streamRetryAfterMs = retryAfterMs

					Log("[proxy] #%d [STREAM-QUOTA] %s detected mid-stream model=%s retryAfter=%dms, aborting stream (timo-style)",
						reqId, reason, modelKey, retryAfterMs)

					// 1. 中断上游连接（停止从 Google 读取更多数据）
					if closer, ok := body.(io.Closer); ok {
						closer.Close()
					}
					// 2. 向 IDE 发送 SSE 结束标记，避免 IDE 侧无限等待
					if ok {
						_ = writeAndFlush([]byte("\ndata: [DONE]\n\n"))
					}
					Log("[proxy] #%d [STREAM-QUOTA] upstream destroyed, stream ended with [DONE]", reqId)
					break // 退出读取循环
				}
			}

			// 只有在非 quota 中断的情况下才转发数据给 IDE
			writeErr := writeAndFlush(buffer[:n])
			// 下游断开（broken pipe）→ 停止从上游读取，节省 API 配额
			if writeErr != nil {
				Log("[proxy] #%d [STREAM] downstream write error, aborting: %v", reqId, writeErr)
				if closer, cOk := body.(io.Closer); cOk {
					closer.Close()
				}
				break
			}
		}
		if err != nil {
			if err != io.EOF && !streamTimedOut.Load() {
				Log("[proxy] #%d Stream read error: %v", reqId, err)
			}
			break
		}
	}

	// Parse cumulative tokens from the stream
	p.mu.Lock()
	modelKey := p.lastModelKey
	p.mu.Unlock()
	result := p.parseAndAddTokenUsage(tailBuffer.Bytes(), "", modelKey)

	// 附加流式错误信息，通知调用方上报
	if streamQuotaDetected {
		result.StreamError = true
		result.StreamErrorReason = streamErrorReason
		result.StreamErrorModel = streamErrorModel
		result.StreamRetryAfterMs = streamRetryAfterMs
		result.StreamBytes = totalStreamBytes.Load()
	}
	return result
}

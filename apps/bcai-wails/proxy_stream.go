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

// alreadyForwarded 表示调用方在进入本函数前是否已向 IDE 写过正常内容
// （例如 handleGenerationRequest 先写出的 firstChunk）。一旦转发过
// content/tool_use，中途即便匹配到 quota 字样也绝不掐流——见 forwardedContent。
func (p *ProxyServer) streamResponse(w http.ResponseWriter, body io.Reader, reqId int64, alreadyForwarded bool) TokenUsageResult {
	buffer := make([]byte, 32768) // 32KB read buffer（减少系统调用，提升流式吞吐）
	// 尾部缓冲：仅保留流的最后 16KB 用于解析 token 用量（usageMetadata 只出现在末尾）
	var tailBuffer bytes.Buffer
	const tailBufferMax = 16384
	streamQuotaDetected := false

	// 是否已向 IDE 转发过正常内容。一旦转发过 content/tool_use，中途再匹配到
	// quota 字样也只当软信号、绝不掐流:硬掐会截断进行中的工具调用（IDE 表现为
	// "说要调用工具却没反应"），且此时响应头已提交、无法换号，掐了只剩残缺响应。
	// 还能避免裸子串误判命中模型正文时丢弃合法内容。
	forwardedContent := alreadyForwarded
	streamQuotaSoft := false

	// 滑动窗口缓冲：防止 quota 错误 JSON 被 chunk 边界切断（timo 使用 Rust async stream 无此问题）
	var recentWindow bytes.Buffer
	const recentWindowMax = 4096

	// 流式错误信息，用于通知调用方上报
	var streamErrorReason, streamErrorModel string
	var streamRetryAfterMs int64
	var totalStreamBytes atomic.Int64
	// 上游/代理在 body 阶段异常掐断时记录原因（用于诊断"长文输出断"）
	var streamAbortErr error

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
	// 与 upstream_net.go 的 ResponseHeaderTimeout 配对，二者取短板，必须同步调整
	const streamFirstByteTimeout = 300 * time.Second // 5 min for long-context thinking
	streamMidCheckInterval := 60 * time.Second       // 60s between health checks
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
						if closer, ok := body.(io.Closer); ok {
							closer.Close()
						}
						return
					}
				}
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

					if forwardedContent {
						// 已向 IDE 转发过正常内容 → 软信号:不掐流、不注入 [DONE]，
						// 把剩余流（含这一块）原样转发完。既不截断进行中的工具调用，
						// 也不会在裸子串误判命中模型正文时丢弃合法内容。
						streamQuotaSoft = true
					} else {
						// 还没向 IDE 发过任何正常内容 → 纯错误开头，掐掉不截断任何东西。
						// 1. 中断上游连接（停止从 Google 读取更多数据）
						if closer, ok := body.(io.Closer); ok {
							closer.Close()
						}
						// 2. 向 IDE 发送 SSE 结束标记，避免 IDE 侧无限等待
						if ok {
							_ = writeAndFlush([]byte("\ndata: [DONE]\n\n"))
						}
						break // 退出读取循环
					}
				}
			}

			// 转发数据给 IDE（软信号下也照常转发，保持流完整）
			writeErr := writeAndFlush(buffer[:n])
			// 下游断开（broken pipe）→ 停止从上游读取，节省 API 配额
			if writeErr != nil {
				if closer, cOk := body.(io.Closer); cOk {
					closer.Close()
				}
				break
			}
			// 成功转发过一块真实 body 数据 → 此后任何 quota 匹配都只当软信号。
			forwardedContent = true
		}
		if err != nil {
			// 区分正常结束 / 本地主动超时关闭 / 上游·代理异常掐断
			// 只有最后一种才是需要排查的"长文输出中途断"
			if err != io.EOF && !streamTimedOut.Load() {
				streamAbortErr = err
			}
			break
		}
	}

	// Parse cumulative tokens from the stream
	p.mu.Lock()
	modelKey := p.lastModelKey
	p.mu.Unlock()
	result := p.parseAndAddTokenUsage(tailBuffer.Bytes(), "", modelKey)

	// 始终回报已收字节数 + 中断诊断（供调用方写入审计日志）
	result.StreamBytes = totalStreamBytes.Load()
	result.StreamTimedOut = streamTimedOut.Load()
	if streamAbortErr != nil {
		result.StreamAbortErr = streamAbortErr.Error()
	}

	// 附加流式错误信息，通知调用方上报
	if streamQuotaDetected {
		if streamQuotaSoft {
			// 已完整转发 → 软信号:本次按成功处理，仅供日志，不计错误、不惩罚账号。
			result.StreamQuotaSoft = true
		} else {
			result.StreamError = true
		}
		result.StreamErrorReason = streamErrorReason
		result.StreamErrorModel = streamErrorModel
		result.StreamRetryAfterMs = streamRetryAfterMs
	}
	return result
}

// noteStreamAbort 把流式 body 阶段的中断诊断追加到审计备注，
// 让日志能区分"长文输出断"到底是上游/代理掐断还是本地超时主动关闭。
func noteStreamAbort(audit *proxyAudit, r TokenUsageResult) {
	if r.StreamAbortErr != "" {
		audit.note += fmt.Sprintf("; 流中途断开:%s(已收%d字节)", r.StreamAbortErr, r.StreamBytes)
	} else if r.StreamTimedOut {
		kind := "空闲超时"
		if r.StreamBytes == 0 {
			kind = "首字节超时"
		}
		audit.note += fmt.Sprintf("; 流%s主动关闭(已收%d字节)", kind, r.StreamBytes)
	}
}

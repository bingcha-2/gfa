package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// ─── Anthropic SSE 用量计量 ─────────────────────────────────────────────────
//
// Claude 流式响应把 token 用量分散在两类事件里(对照 reclaude internal/metering):
//   - message_start:usage.input_tokens(最终值)+ cache_creation/cache_read +
//     output_tokens(占位,通常为 1)
//   - message_delta:usage.output_tokens —— 这是**累计的最终输出量**(不是增量),
//     流末尾下发。因此输出取"见过的最大值"(而非累加),避免把占位的 1 叠上去多算。
//
// 计费交给服务端:上报 rawTotal=input+output+cacheCreation+cacheRead,
// cachedInputTokens=cache_read(可被服务端按 1/10 折扣)。

type claudeUsage struct {
	InputTokens              int64
	OutputTokens             int64
	CacheCreationInputTokens int64
	CacheReadInputTokens     int64
}

// rawTotal 原始总量(供 ReportDetails.RawTotalTokens)。
func (u claudeUsage) rawTotal() int64 {
	return u.InputTokens + u.OutputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
}

// claudeSSEParser 增量喂入 SSE 字节,按 \n\n 切出完整事件块并解析 usage。
// 取"最大值"语义:重复/多次事件不会重复累计。
type claudeSSEParser struct {
	buf []byte
	u   claudeUsage
}

// Write 喂入任意大小的字节块(可跨事件边界),解析其中所有完整事件。
func (p *claudeSSEParser) Write(b []byte) {
	p.buf = append(p.buf, b...)
	for {
		idx := bytes.Index(p.buf, []byte("\n\n"))
		if idx < 0 {
			break
		}
		p.parseEvent(p.buf[:idx])
		p.buf = p.buf[idx+2:]
	}
}

// Usage 解析残留的不完整尾块并返回累计 usage。
func (p *claudeSSEParser) Usage() claudeUsage {
	if len(p.buf) > 0 {
		p.parseEvent(p.buf)
		p.buf = p.buf[:0]
	}
	return p.u
}

type claudeSSEUsageShape struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

type claudeSSEDataShape struct {
	Type    string `json:"type"`
	Message *struct {
		Usage claudeSSEUsageShape `json:"usage"`
	} `json:"message"`
	Usage *claudeSSEUsageShape `json:"usage"`
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// parseEvent 解析单个 SSE 事件块(event:/data: 行),把 usage 字段并入累计值。
func (p *claudeSSEParser) parseEvent(block []byte) {
	var dataLine []byte
	for _, line := range bytes.Split(block, []byte("\n")) {
		line = bytes.TrimRight(line, "\r")
		if bytes.HasPrefix(line, []byte("data:")) {
			dataLine = bytes.TrimSpace(line[len("data:"):])
		}
	}
	if len(dataLine) == 0 || dataLine[0] != '{' {
		return
	}
	var d claudeSSEDataShape
	if json.Unmarshal(dataLine, &d) != nil {
		return
	}
	// message_start 携带 input/cache(最终值)。用 max 防重复事件叠加。
	if d.Message != nil {
		mu := d.Message.Usage
		p.u.InputTokens = maxInt64(p.u.InputTokens, mu.InputTokens)
		p.u.CacheCreationInputTokens = maxInt64(p.u.CacheCreationInputTokens, mu.CacheCreationInputTokens)
		p.u.CacheReadInputTokens = maxInt64(p.u.CacheReadInputTokens, mu.CacheReadInputTokens)
		p.u.OutputTokens = maxInt64(p.u.OutputTokens, mu.OutputTokens)
	}
	// message_delta(及任何带顶层 usage 的事件)携带累计 output_tokens。
	if d.Usage != nil {
		p.u.OutputTokens = maxInt64(p.u.OutputTokens, d.Usage.OutputTokens)
		// 极少数实现也会在顶层重述 input/cache,一并取 max(不会少算)。
		p.u.InputTokens = maxInt64(p.u.InputTokens, d.Usage.InputTokens)
		p.u.CacheCreationInputTokens = maxInt64(p.u.CacheCreationInputTokens, d.Usage.CacheCreationInputTokens)
		p.u.CacheReadInputTokens = maxInt64(p.u.CacheReadInputTokens, d.Usage.CacheReadInputTokens)
	}
}

// copyStreamingClaudeResponse 边把 Anthropic SSE 原样转发给下游(w 实现 Flusher 则
// 逐块 flush),边解析最终 usage。镜像 copyStreamingCodexResponse 的流式拷贝结构。
func copyStreamingClaudeResponse(w io.Writer, body io.Reader) (claudeUsage, error) {
	flusher, _ := w.(http.Flusher)
	var parser claudeSSEParser
	buffer := make([]byte, 32*1024)
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			if _, writeErr := w.Write(chunk); writeErr != nil {
				return parser.Usage(), writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
			parser.Write(chunk)
		}
		if err == io.EOF {
			return parser.Usage(), nil
		}
		if err != nil {
			return parser.Usage(), err
		}
	}
}

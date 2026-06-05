package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
)

// TokenUsageResult holds parsed token counts and the billable total after
// applying the cached-token discount (cached tokens count as 1/10).
type TokenUsageResult struct {
	InputTokens         int64
	OutputTokens        int64
	CachedInputTokens   int64
	RawTotalTokens      int64
	BillableTotalTokens int64 // rawTotal - cached + ceil(cached/10)
	// Mid-stream quota/capacity error (timo-style detection)
	StreamError        bool
	StreamErrorReason  string // "quota" or "capacity"
	StreamErrorModel   string
	StreamRetryAfterMs int64
	StreamBytes        int64 // bytes received before error
}

// discountedCachedTokens returns the billable portion of cached tokens.
// Cached tokens are billed at 1/10 of their count (ceil), matching the
// plugin's discountedCachedTokens (token-proxy.js L306-309).
func discountedCachedTokens(cached int64) int64 {
	if cached <= 0 {
		return 0
	}
	return (cached + 9) / 10 // ceil(cached / 10)
}

// classifyModel 将模型名分类为厂商族(gemini/claude/gpt),复用唯一分类真源
// modelFamily(product_bucket.go),不再各写一套 Contains 特判。空名返回 other。
func classifyModel(modelKey string) string {
	if modelKey == "" {
		return "other"
	}
	return modelFamily(modelKey)
}

func (p *ProxyServer) parseAndAddTokenUsage(data []byte, contentEncoding string, modelKey string) TokenUsageResult {
	var text string
	if strings.Contains(strings.ToLower(contentEncoding), "gzip") {
		gr, err := gzip.NewReader(bytes.NewReader(data))
		if err == nil {
			defer gr.Close()
			decompressed, err := io.ReadAll(gr)
			if err == nil {
				text = string(decompressed)
			}
		}
	} else {
		text = string(data)
	}

	if text == "" {
		text = string(data)
	}

	// Simple regex/substring searches for token counts inside JSON
	inputTokens := extractFieldCount(text, "promptTokenCount", "inputTokenCount", "promptTokens", "inputTokens")
	outputTokens := extractFieldCount(text, "candidatesTokenCount", "outputTokenCount", "completionTokens", "outputTokens")
	// thoughtsTokenCount 累加到 output（与插件 token-proxy.js L337-339 一致）
	thoughtTokens := extractFieldCount(text, "thoughtsTokenCount")
	if thoughtTokens > 0 {
		outputTokens += thoughtTokens
	}
	cachedTokens := extractFieldCount(text, "cachedContentTokenCount", "cachedPromptTokenCount", "cacheTokenCount", "cachedInputTokens")
	// cachedInputTokens 不能超过 inputTokens
	if cachedTokens > inputTokens {
		cachedTokens = inputTokens
	}

	// 计算 rawTotal 和 billable（缓存 token 按 1/10 计费）
	rawTotal := inputTokens + outputTokens
	var billable int64
	if cachedTokens > 0 {
		// billable = rawTotal - cachedInput + ceil(cachedInput/10)
		billable = rawTotal - cachedTokens + discountedCachedTokens(cachedTokens)
		if billable < 0 {
			billable = 0
		}
	} else {
		billable = rawTotal
	}

	if inputTokens > 0 || outputTokens > 0 {
		Log("[proxy] Token usage: input=%d, output=%d, cached=%d, thought=%d, billable=%d model=%s",
			inputTokens, outputTokens, cachedTokens, thoughtTokens, billable, modelKey)
	}

	if inputTokens > 0 {
		atomic.AddInt64(&p.stats.TotalInputTokens, inputTokens)
	}
	if outputTokens > 0 {
		atomic.AddInt64(&p.stats.TotalOutputTokens, outputTokens)
	}
	if cachedTokens > 0 {
		atomic.AddInt64(&p.stats.TotalCachedTokens, cachedTokens)
	}

	// 按模型分类累加
	category := classifyModel(modelKey)
	switch category {
	case "claude":
		if inputTokens > 0 {
			atomic.AddInt64(&p.stats.OpusInputTokens, inputTokens)
		}
		if outputTokens > 0 {
			atomic.AddInt64(&p.stats.OpusOutputTokens, outputTokens)
		}
	case "gemini":
		if inputTokens > 0 {
			atomic.AddInt64(&p.stats.GeminiInputTokens, inputTokens)
		}
		if outputTokens > 0 {
			atomic.AddInt64(&p.stats.GeminiOutputTokens, outputTokens)
		}
	}

	// 持久化到每日统计
	if inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 {
		GetUsageStats().AddTokens(inputTokens, outputTokens, cachedTokens)
	}

	return TokenUsageResult{
		InputTokens:         inputTokens,
		OutputTokens:        outputTokens,
		CachedInputTokens:   cachedTokens,
		RawTotalTokens:      rawTotal,
		BillableTotalTokens: billable,
	}
}

func extractFieldCount(text string, fields ...string) int64 {
	var maxCount int64 = 0
	for _, field := range fields {
		// Custom simple regex match
		idx := 0
		for {
			loc := strings.Index(text[idx:], fmt.Sprintf(`"%s"`, field))
			if loc == -1 {
				break
			}
			start := idx + loc + len(field) + 2
			// Search for colon and then digit
			colonIdx := strings.Index(text[start:], ":")
			if colonIdx != -1 {
				digitStart := start + colonIdx + 1
				// skip whitespace
				for digitStart < len(text) && (text[digitStart] == ' ' || text[digitStart] == '\t' || text[digitStart] == '\r' || text[digitStart] == '\n') {
					digitStart++
				}
				digitEnd := digitStart
				for digitEnd < len(text) && text[digitEnd] >= '0' && text[digitEnd] <= '9' {
					digitEnd++
				}
				if digitEnd > digitStart {
					var count int64
					_, err := fmt.Sscanf(text[digitStart:digitEnd], "%d", &count)
					if err == nil && count > maxCount {
						maxCount = count
					}
				}
			}
			idx += loc + len(field) + 2
		}
	}
	return maxCount
}

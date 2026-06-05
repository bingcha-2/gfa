package main

import (
	"errors"
	"io"
	"strings"
)

// claudeAuxMaxAttempts 是 count_tokens 等辅助请求遇瞬时连接错误时的最大尝试次数。
const claudeAuxMaxAttempts = 3

// isRetriableUpstreamErr 判断上游错误是否为可安全重试的瞬时连接错误。
// 仅针对幂等、不计费的辅助请求(count_tokens)使用；持久错误(如 connection refused
// = 出口代理不可达)不重试，避免掩盖配置问题、徒增延迟。
func isRetriableUpstreamErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	s := strings.ToLower(err.Error())
	if strings.Contains(s, "connection refused") {
		return false
	}
	return strings.Contains(s, "eof") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "broken pipe")
}

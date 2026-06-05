package main

import (
	"errors"
	"io"
	"testing"
)

// count_tokens 等辅助请求在突发并发下偶发上游 EOF/连接重置；这些是瞬时连接错误，
// 幂等且不计费，应可安全重试。isRetriableUpstreamErr 负责识别这类错误。
func TestIsRetriableUpstreamErr(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"io.EOF", io.EOF, true},
		{"unexpected EOF", io.ErrUnexpectedEOF, true},
		{"post wrapped EOF", errors.New(`Post "https://api.anthropic.com/v1/messages/count_tokens?beta=true": EOF`), true},
		{"connection reset", errors.New("read tcp: connection reset by peer"), true},
		{"broken pipe", errors.New("write: broken pipe"), true},
		{"connection refused (持久错误,不重试)", errors.New("dial tcp: connection refused"), false},
		{"http 401 (业务错误,不重试)", errors.New("401 unauthorized"), false},
	}
	for _, c := range cases {
		if got := isRetriableUpstreamErr(c.err); got != c.want {
			t.Errorf("%s: isRetriableUpstreamErr = %v, want %v", c.name, got, c.want)
		}
	}
}

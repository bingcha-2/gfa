package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestClaudeProxyAuxIncludesTransportDetailsAfterRetries(t *testing.T) {
	rawErr := `Post "https://api.anthropic.com/v1/messages/count_tokens": EOF`
	attempts := 0
	p := &ClaudeProxy{
		leaseToken: func(card, deviceId string, force bool, opts map[string]interface{}, up string) (*ClaudeTokenLease, error) {
			return &ClaudeTokenLease{AccessToken: "sk-ant-oauth", AccountId: 7, LeaseId: "l1", EgressInfo: EgressInfo{ProxyURL: "http://egress.test:8080", EgressRequired: true}}, nil
		},
		upstreamClient: func(string) *http.Client {
			return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				attempts++
				return nil, errors.New(rawErr)
			})}
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`{"model":"claude-opus-4-8"}`))
	rw := httptest.NewRecorder()

	p.ServeHTTP(rw, req, "card-1", "dev-1", "")

	if rw.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rw.Code)
	}
	if attempts != claudeAuxMaxAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, claudeAuxMaxAttempts)
	}
	message := decodeClaudeProxyErrorMessage(t, rw.Body.Bytes())
	if !strings.Contains(message, claudeTransportFriendlyMessage) {
		t.Fatalf("client error message = %q, want friendly message %q", message, claudeTransportFriendlyMessage)
	}
	if !strings.Contains(message, "原始错误: ") || !strings.Contains(message, "/v1/messages/count_tokens") || !strings.Contains(message, "EOF") {
		t.Fatalf("client error message = %q, want raw transport error %q", message, rawErr)
	}
}

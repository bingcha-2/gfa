package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Classification is observational: preserve provider codes and never infer an
// account restriction from the human-readable capacity banner alone.
func codexFailureClass(code string, status int) string {
	switch strings.ToLower(code) {
	case "server_is_overloaded", "slow_down":
		return "capacity"
	case "rate_limit_exceeded", "rate_limit_error":
		return "rate_limit"
	case "usage_limit_reached", "quota_exceeded", "insufficient_quota":
		return "quota"
	case "invalid_api_key", "invalid_token", "token_expired":
		return "authentication"
	case "account_deactivated", "access_denied", "permission_denied", "verification_required":
		return "access"
	}
	if status == 401 {
		return "authentication"
	}
	if status == 403 {
		return "access"
	}
	if status == 429 {
		return "rate_limit_unknown"
	}
	if status >= 500 {
		return "upstream_error"
	}
	return "unknown"
}

// A retry is allowed only for a complete, bounded HTTP 503 JSON rejection.
// Streams, ambiguous transport failures, authentication and quota errors are
// never replayed here. The same request/credentials/endpoint are retained.
func doCodexRequest(req *http.Request, send func(*http.Request) (*http.Response, error)) (*http.Response, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	resp, err := send(req)
	if err != nil || resp == nil || req.GetBody == nil || req.Context().Err() != nil {
		return resp, err
	}
	if resp.StatusCode != http.StatusServiceUnavailable ||
		!strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") ||
		(resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") {
		return resp, nil
	}
	delay, ok := codexRetryDelay(resp.Header.Get("Retry-After"), time.Now())
	if !ok {
		return resp, nil
	}
	// Never wait on an unbounded error body to decide whether to retry.
	if resp.ContentLength < 0 || resp.ContentLength > 64*1024 {
		return resp, nil
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64*1024+1))
	if readErr != nil {
		_ = resp.Body.Close()
		return nil, readErr
	}
	original := resp.Body
	resp.Body = &codexReplayBody{Reader: io.MultiReader(bytes.NewReader(body), original), Closer: original}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Output   json.RawMessage `json:"output"`
		Usage    json.RawMessage `json:"usage"`
		Response json.RawMessage `json:"response"`
	}
	if len(body) > 64*1024 || json.Unmarshal(body, &payload) != nil ||
		codexFailureClass(payload.Error.Code, 0) != "capacity" ||
		len(payload.Output) != 0 || len(payload.Usage) != 0 || len(payload.Response) != 0 {
		return resp, nil
	}
	retryBody, err := req.GetBody()
	if err != nil {
		return resp, nil
	}
	_ = resp.Body.Close()
	if err := waitCodexRetry(req.Context(), delay); err != nil {
		_ = retryBody.Close()
		return nil, err
	}
	Log("[codex-proxy] source=upstream class=capacity retry=1 request_id=%s", codexDiagnosticID(resp.Header.Get("X-Request-Id")))
	retry := req.Clone(req.Context())
	retry.Body = retryBody
	return send(retry) // one retry total, no recursive retry budget
}

type codexReplayBody struct {
	io.Reader
	io.Closer
}

func doCodexSingleAttempt(egress EgressInfo, proxy string, req *http.Request) (*http.Response, error) {
	resolved, blocked := resolveEgress(egress, proxy)
	if blocked {
		return nil, errEgressRequired
	}
	// A transport error before response headers does not prove the provider
	// didn't accept the generation. Do not replay it on a different route.
	return createCodexStreamingHttpClient(resolved).Do(req)
}

func codexRetryDelay(value string, now time.Time) (time.Duration, bool) {
	delay := time.Second
	if value != "" {
		if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
			if seconds < 0 || seconds > 5 {
				return 0, false
			}
			delay = time.Duration(seconds) * time.Second
		} else if date, err := http.ParseTime(value); err == nil {
			delay = date.Sub(now)
		} else {
			return 0, false
		}
	}
	if delay < time.Second {
		delay = time.Second
	}
	return delay, delay <= 5*time.Second
}

func waitCodexRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

package codexbiz

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// buildSubscriptionHeaders 照搬 cockpit build_subscription_headers:
// Authorization / Accept / Referer / User-Agent / x-openai-target-path /
// x-openai-target-route(= targetPath)+ 可选 ChatGPT-Account-Id。
func buildSubscriptionHeaders(req *http.Request, acc Account, targetPath string) {
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", chatGPTWebReferer)
	req.Header.Set("User-Agent", chatGPTWebUserAgent)
	req.Header.Set("x-openai-target-path", targetPath)
	req.Header.Set("x-openai-target-route", targetPath)
	if id := normalizeOptional(acc.AccountID); id != "" {
		req.Header.Set("ChatGPT-Account-Id", id)
	}
}

// buildCodexAPIHeaders 照搬 cockpit build_codex_api_headers:
// 含 Content-Type / OpenAI-Beta=codex-1 / originator=Codex Desktop + ChatGPT-Account-Id。
func buildCodexAPIHeaders(req *http.Request, acc Account) {
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Referer", chatGPTWebReferer)
	req.Header.Set("User-Agent", chatGPTWebUserAgent)
	req.Header.Set("OpenAI-Beta", "codex-1")
	req.Header.Set("originator", "Codex Desktop")
	if id := acc.chatGPTAccountID(); id != "" {
		req.Header.Set("ChatGPT-Account-Id", id)
	}
}

// ── JWT(codex 不验签,仅解 payload;移植自 codex_account.rs)──

func extractChatGPTAccountID(accessToken string) string {
	payload := decodeJWTPayload(accessToken)
	if payload == nil {
		return ""
	}
	authData, _ := payload["https://api.openai.com/auth"].(map[string]any)
	if authData == nil {
		return ""
	}
	for _, k := range []string{"chatgpt_account_id", "account_id"} {
		if v, ok := authData[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		raw, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil
		}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

// ── HTTP 错误诊断(照搬 extract_detail_code_from_body / append_http_error_diagnostics)──

func extractDetailCodeFromBody(body []byte) string {
	var v map[string]json.RawMessage
	if err := json.Unmarshal(body, &v); err != nil {
		return ""
	}
	if code := nestedString(v, "detail", "code"); code != "" {
		return code
	}
	if code := nestedString(v, "error", "code"); code != "" {
		return code
	}
	var top struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &top)
	return top.Code
}

func nestedString(m map[string]json.RawMessage, outer, inner string) string {
	raw, ok := m[outer]
	if !ok {
		return ""
	}
	var sub map[string]any
	if err := json.Unmarshal(raw, &sub); err != nil {
		return ""
	}
	s, _ := sub[inner].(string)
	return s
}

// httpError 照搬 cockpit 通用错误格式:"<前缀> <status> [error_code:..] [body_len:..]"。
func httpError(prefix string, status int, body []byte) error {
	msg := fmt.Sprintf("%s %d", prefix, status)
	if code := extractDetailCodeFromBody(body); code != "" {
		msg += fmt.Sprintf(" [error_code:%s]", code)
	}
	msg += fmt.Sprintf(" [body_len:%d]", len(body))
	return fmt.Errorf("%s", msg)
}

// ── 标量归一(照搬 normalize_optional_ref / normalize_optional_json_scalar)──

func normalizeOptional(raw string) string {
	return strings.TrimSpace(raw)
}

func normalizeJSONScalar(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return ""
	}
}

func nowUnix() int64 { return time.Now().Unix() }

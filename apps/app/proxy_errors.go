package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ═══════════════════════════════════════════════════════════════════════════
// Error classification
// ═══════════════════════════════════════════════════════════════════════════

func cloudCodeAccountProblemReason(statusCode int, body string) string {
	lowerBody := strings.ToLower(body)
	googleStatus, googleDetailReason := googleErrorStatusAndReason(body)
	switch statusCode {
	case http.StatusUnauthorized:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "token_expired"))
	case http.StatusBadRequest:
		// #2: Detect location_unsupported errors (mirrors token-proxy.js L900-908)
		if isLocationUnsupportedError(lowerBody) {
			return buildAccountProblemReason(statusCode, "location_unsupported")
		}
		return ""
	case http.StatusTooManyRequests:
		// 429 的具体 ErrorInfo.reason(如 INSUFFICIENT_G1_CREDITS_BALANCE / RATE_LIMIT_EXCEEDED)
		// 优先于笼统的 status(永远是 RESOURCE_EXHAUSTED)。否则上层日志/控制台/冷却原因永远只看到
		// resource_exhausted,分不清"信用耗尽(换号+长冷却)"和"瞬时限流"。
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleDetailReason, googleStatus, "too_many_requests"))
	case http.StatusForbidden:
		// 验证挑战(VALIDATION_REQUIRED / "Verify your account")必须先判 —— 它的报文里带
		// "domain": "cloudcode-pa.googleapis.com",会被下面的 service_disabled 规则误吞。
		// 这是账号被 Google 风控、需人工验证,不是"服务禁用"。
		if strings.Contains(lowerBody, "verify") ||
			strings.Contains(lowerBody, "validation") ||
			strings.Contains(lowerBody, "al_alert") {
			return buildAccountProblemReason(statusCode, "account_verification_required")
		}
		if strings.Contains(lowerBody, "service_disabled") ||
			strings.Contains(lowerBody, "cloud code private api") ||
			strings.Contains(lowerBody, "cloudcode-pa.googleapis.com") ||
			strings.Contains(lowerBody, "api has not been used in project") ||
			strings.Contains(lowerBody, "enable it by visiting") {
			return buildAccountProblemReason(statusCode, "service_disabled")
		}
		if strings.Contains(lowerBody, "permission_denied") && strings.Contains(lowerBody, "cloudcode-pa.googleapis.com") {
			return buildAccountProblemReason(statusCode, "service_disabled")
		}
		if googleStatus != "" || googleDetailReason != "" {
			return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "forbidden"))
		}
		return buildAccountProblemReason(statusCode, "forbidden")
	case http.StatusServiceUnavailable:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "service_unavailable"))
	case http.StatusInternalServerError:
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "internal_error"))
	}
	return ""
}

func googleErrorStatusAndReason(body string) (string, string) {
	var payload struct {
		Error struct {
			Status  string                   `json:"status"`
			Details []map[string]interface{} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return "", ""
	}

	for _, detail := range payload.Error.Details {
		if reason, ok := detail["reason"].(string); ok && reason != "" {
			return payload.Error.Status, reason
		}
	}
	return payload.Error.Status, ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func buildAccountProblemReason(statusCode int, reason string) string {
	return sanitizeAccountProblemReason(fmt.Sprintf("http_%d_%s", statusCode, reason))
}

func sanitizeAccountProblemReason(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastUnderscore := false

	for _, r := range value {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlphaNum {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}

	result := strings.Trim(b.String(), "_")
	if len(result) > 120 {
		result = result[:120]
	}
	return result
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming quota error detection
// ═══════════════════════════════════════════════════════════════════════════

// errorKeyNeedle 是 JSON 错误对象的键。热路径(每 chunk)用它做零分配的"是否可能含
// 上游错误"预判 —— 包级变量,避免每次 []byte("...") 转换可能的分配。
var errorKeyNeedle = []byte(`"error"`)

// checkStreamingQuotaError detects quota/capacity exhaustion errors in
// streaming response chunks. Mirrors the extension's getStreamingRotationDetails
// (token-proxy.js L943-971).
//
// 结构化判定:只在【上游返回的顶层 error 对象】里匹配,绝不扫模型正文
// (candidates / content / parts / functionCall / inlineData)。Google 的
// cloudcode-pa 会用 HTTP 200 把配额错误塞进 SSE 流体,但永远是 {"error":{...}}
// 结构;模型正常产出/工具调用里即使出现 "resource_exhausted" 等字样也只是内容,
// 不是上游错误,绝不能据此掐流(否则截断生图/工具调用)。
func checkStreamingQuotaError(chunk string) (reason, modelKey string, retryAfterMs int64) {
	// 快速路径(热路径性能):本函数对每个流 chunk 的 4KB 滑窗都会被调一次。绝大多数
	// chunk 是正常模型内容,连 JSON 的 "error" 键都没有 —— 直接 substring 判一下就返回,
	// 不做 split / json 解析。只有真出现 "error" 键时才走下面的结构化解析(此时才可能是
	// Google 200-内嵌错误)。
	if !strings.Contains(chunk, `"error"`) {
		return "", "", 0
	}
	errDoc := extractGoogleErrorDoc(chunk)
	if errDoc == "" {
		return "", "", 0
	}
	lower := strings.ToLower(errDoc)
	mk := extractCapacityModelKey(errDoc)

	if strings.Contains(lower, "baseline model quota reached") ||
		strings.Contains(lower, "quota reached") ||
		strings.Contains(lower, "quota_exhausted") ||
		strings.Contains(lower, "resource_exhausted") {
		return "quota", mk, extractQuotaResetDelayMs(errDoc)
	}
	if strings.Contains(lower, "model_capacity_exhausted") ||
		strings.Contains(lower, "no capacity available") ||
		strings.Contains(lower, "capacity available for model") {
		return "capacity", mk, extractQuotaResetDelayMs(errDoc)
	}
	return "", "", 0
}

// extractGoogleErrorDoc 从一段(可能含多条 SSE 事件 / JSON 数组分片的)流文本里,
// 找出第一个带【非空顶层 error 字段】的完整 JSON 文档并原样返回(形如
// {"error":{...}});找不到返回 ""。用结构判定取代裸子串:模型正文里的
// candidates/content 不带顶层 error,天然不会命中。
func extractGoogleErrorDoc(chunk string) string {
	for _, cand := range jsonObjectCandidates(chunk) {
		var probe struct {
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal([]byte(cand), &probe) != nil {
			continue
		}
		trimmed := strings.TrimSpace(string(probe.Error))
		if trimmed != "" && trimmed != "null" {
			return cand
		}
	}
	return ""
}

// jsonObjectCandidates 从流文本里拆出"可能是完整 JSON 对象"的候选串:逐行
// (去掉 SSE 的 data: 前缀)+ 整段兜底,剥掉数组流分片的包裹符 [ , ],只保留
// 以 { 开头的串。错误事件通常自成一行,逐行解析比裸扫整段更稳、零误判。
func jsonObjectCandidates(chunk string) []string {
	var out []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		s = strings.TrimPrefix(s, "data:")
		s = strings.TrimSpace(s)
		s = strings.Trim(s, "[],") // 数组流分片:剥掉首尾的 [ ] ,
		s = strings.TrimSpace(s)
		if strings.HasPrefix(s, "{") {
			out = append(out, s)
		}
	}
	for _, line := range strings.Split(chunk, "\n") {
		add(line)
	}
	add(chunk) // 单行 / 无换行的 firstChunk 兜底
	return out
}

// ═══════════════════════════════════════════════════════════════════════════
// Quota reset delay parsing
// ═══════════════════════════════════════════════════════════════════════════

// extractQuotaResetDelayMs parses the 429 error response to extract the
// precise cooldown duration — mirrors the extension's extractQuotaResetDelayMs
// (token-proxy.js L794-857). Supports:
//   - error.details[].metadata.quotaResetDelay  ("5h30m0s")
//   - error.details[].metadata.quotaResetTimeStamp  (ISO timestamp)
//   - error.message  "reset after 4h59m35s"
//   - "refresh on 5/24/2026, 3:00 AM"
func extractQuotaResetDelayMs(errorText string) int64 {
	if errorText == "" {
		return 0
	}

	// Try JSON structured parsing first
	var payload struct {
		Error struct {
			Message string                   `json:"message"`
			Details []map[string]interface{} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(errorText), &payload) == nil {
		for _, detail := range payload.Error.Details {
			metadata, _ := detail["metadata"].(map[string]interface{})
			if metadata == nil {
				continue
			}
			// quotaResetDelay: "5h30m0s"
			if delay, ok := metadata["quotaResetDelay"].(string); ok && delay != "" {
				if ms := parseDurationToMs(delay); ms > 0 {
					return ms
				}
			}
			// quotaResetTimeStamp: ISO timestamp
			if ts, ok := metadata["quotaResetTimeStamp"].(string); ok && ts != "" {
				if t, err := time.Parse(time.RFC3339, ts); err == nil {
					ms := t.UnixMilli() - time.Now().UnixMilli()
					if ms > 0 {
						return ms
					}
				}
			}
		}
		// Try parsing duration from error.message: "reset after 4h59m35s"
		if ms := parseDurationToMs(payload.Error.Message); ms > 0 {
			return ms
		}
	}

	// Fallback: regex "reset after 4h59m35s"
	re := regexp.MustCompile(`(?i)reset after ([^.:]+(?:\.\d+)?s)`)
	if m := re.FindStringSubmatch(errorText); len(m) > 1 {
		if ms := parseDurationToMs(m[1]); ms > 0 {
			return ms
		}
	}

	// Try full text duration parse
	if ms := parseDurationToMs(errorText); ms > 0 {
		return ms
	}

	return 0
}

// parseRetryAfterHeaderMs 解析 HTTP `Retry-After` 头 → 毫秒。支持两种标准格式:
//   - 秒数:        "60"
//   - HTTP-date:   "Wed, 21 Oct 2026 07:28:00 GMT"
// Anthropic 的 rate_limit_error 429 把恢复时间放在【这个响应头】里(body 里没有,
// extractQuotaResetDelayMs 解析不到),body 取不到 retryAfterMs 时回退读它。解析不到返回 0。
func parseRetryAfterHeaderMs(v string) int64 {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return 0
		}
		return int64(secs) * 1000
	}
	if t, err := http.ParseTime(v); err == nil {
		if ms := t.UnixMilli() - time.Now().UnixMilli(); ms > 0 {
			return ms
		}
	}
	return 0
}

// parseDurationToMs parses human-readable durations like "5h30m10s" → milliseconds.
// Mirrors the extension's parseDurationToMs (token-proxy.js L752-779).
func parseDurationToMs(text string) int64 {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	re := regexp.MustCompile(`(\d+(?:\.\d+)?)(h|m|s)`)
	matches := re.FindAllStringSubmatch(strings.ToLower(text), -1)
	if len(matches) == 0 {
		return 0
	}
	var totalMs float64
	for _, m := range matches {
		amount, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		switch m[2] {
		case "h":
			totalMs += amount * 3600000
		case "m":
			totalMs += amount * 60000
		case "s":
			totalMs += amount * 1000
		}
	}
	return int64(math.Ceil(totalMs))
}

// ═══════════════════════════════════════════════════════════════════════════
// Capacity model key extraction
// ═══════════════════════════════════════════════════════════════════════════

// extractCapacityModelKey extracts model name from 503 capacity error responses.
// Mirrors the extension's extractCapacityModelKey (token-proxy.js L731-749).
func extractCapacityModelKey(errorText string) string {
	if errorText == "" {
		return ""
	}
	// Try structured JSON first
	var payload struct {
		Error struct {
			Details []struct {
				Metadata struct {
					Model string `json:"model"`
				} `json:"metadata"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(errorText), &payload) == nil {
		for _, d := range payload.Error.Details {
			if strings.TrimSpace(d.Metadata.Model) != "" {
				return strings.TrimSpace(d.Metadata.Model)
			}
		}
	}
	// Regex fallback
	re := regexp.MustCompile(`(?i)No capacity available for model ([A-Za-z0-9._-]+)`)
	if m := re.FindStringSubmatch(errorText); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

// ═══════════════════════════════════════════════════════════════════════════
// Verification challenge detection
// ═══════════════════════════════════════════════════════════════════════════

// isVerificationChallengeError detects Google verification challenges in error
// responses. Mirrors the extension's isVerificationChallengeText (L910-929).
func isVerificationChallengeError(errorText string) bool {
	lower := strings.ToLower(errorText)
	return strings.Contains(lower, "please verify your account") ||
		strings.Contains(lower, "verify your account to continue") ||
		strings.Contains(lower, "verify account") ||
		strings.Contains(lower, "verify your info to continue") ||
		strings.Contains(lower, "google needs to verify") ||
		strings.Contains(lower, "verify some info about your device") ||
		strings.Contains(lower, "scan the qr code with your phone") ||
		strings.Contains(lower, "validation_required") ||
		strings.Contains(lower, "validation_url") ||
		strings.Contains(lower, "validation_error_message") ||
		strings.Contains(lower, "permission_denied") ||
		strings.Contains(lower, "al_alert")
}

// isLocationUnsupportedError detects Google "user location is not supported" errors.
// Mirrors the extension's isLocationUnsupportedText (token-proxy.js L900-908).
func isLocationUnsupportedError(lowerBody string) bool {
	return strings.Contains(lowerBody, "user location is not supported") ||
		strings.Contains(lowerBody, "location is not supported for the api use") ||
		(strings.Contains(lowerBody, "failed_precondition") &&
			strings.Contains(lowerBody, "location") &&
			strings.Contains(lowerBody, "not supported"))
}

// ═══════════════════════════════════════════════════════════════════════════
// Retry delay
// ═══════════════════════════════════════════════════════════════════════════

// remoteRetryDelay calculates exponential backoff for remote lease retries.
// Mirrors the extension's remoteRetryDelayMs (token-proxy.js L45-51).
// base=250ms, multiplier=1.3, jitter=0-500ms, max=5000ms
func remoteRetryDelay(attempt int) time.Duration {
	base := 250.0
	multiplier := 1.3
	delay := base * math.Pow(multiplier, float64(attempt-1))
	jitter := rand.Float64() * 500
	total := math.Min(5000, delay+jitter)
	return time.Duration(total) * time.Millisecond
}

// remoteRetryDelayForStatus returns a status-aware retry delay.
// Mirrors the extension's remoteStatusDelayMs (token-proxy.js L54-64).
// 503 gets at least capacityWait (2s), 429 gets at least quotaWait (1s).
func remoteRetryDelayForStatus(attempt int, statusCode int) time.Duration {
	baseDelay := remoteRetryDelay(attempt)
	switch statusCode {
	case http.StatusServiceUnavailable: // 503
		const capacityWaitMs = 2000
		if baseDelay < capacityWaitMs*time.Millisecond {
			return capacityWaitMs * time.Millisecond
		}
	case http.StatusTooManyRequests: // 429
		const quotaWaitMs = 1000
		if baseDelay < quotaWaitMs*time.Millisecond {
			return quotaWaitMs * time.Millisecond
		}
	}
	return baseDelay
}

// ═══════════════════════════════════════════════════════════════════════════
// Report types
// ═══════════════════════════════════════════════════════════════════════════

// ReportDetails contains enriched information for report-result, matching
// the fields sent by the extension's reportRemoteResult (token-proxy.js L1448-1477).
type ReportDetails struct {
	StatusCode          int
	ModelKey            string
	Reason              string
	RetryAfterMs        int64
	InputTokens         int64
	OutputTokens        int64
	CachedInputTokens   int64 // 缓存命中的 input token（按 1/10 计费）
	RawTotalTokens      int64 // input + output 原始总量
	BillableTotalTokens int64 // 折扣后的计费总量
	ErrorText           string

	// Claude 5h/周额度窗口:从上游 anthropic-ratelimit-unified-* 响应头解析(仅 200 带),
	// 随用量上报回服务端 applyQuotaSnapshot → 客户端血条。HasClaudeWindows=false 时不带。
	HasClaudeWindows      bool
	ClaudeHourlyPercent   float64 // 5h 剩余 %(0-100)
	ClaudeWeeklyPercent   float64 // 周 剩余 %(0-100)
	ClaudeHourlyResetTime string  // ISO8601
	ClaudeWeeklyResetTime string  // ISO8601
}

// getErrorSnippet truncates error text for report payloads (max 1200 chars).
func getErrorSnippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 1200 {
		return text[:1200]
	}
	return text
}

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
		return buildAccountProblemReason(statusCode, firstNonEmpty(googleStatus, googleDetailReason, "too_many_requests"))
	case http.StatusForbidden:
		if strings.Contains(lowerBody, "service_disabled") ||
			strings.Contains(lowerBody, "cloud code private api") ||
			strings.Contains(lowerBody, "cloudcode-pa.googleapis.com") ||
			strings.Contains(lowerBody, "api has not been used in project") ||
			strings.Contains(lowerBody, "enable it by visiting") {
			return buildAccountProblemReason(statusCode, "service_disabled")
		}
		if strings.Contains(lowerBody, "verify") || strings.Contains(lowerBody, "validation") {
			return buildAccountProblemReason(statusCode, "account_verification_required")
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

// checkStreamingQuotaError detects quota/capacity exhaustion errors in
// streaming response chunks. Mirrors the extension's getStreamingRotationDetails
// (token-proxy.js L943-971).
func checkStreamingQuotaError(chunk string) (reason, modelKey string, retryAfterMs int64) {
	lower := strings.ToLower(chunk)
	mk := extractCapacityModelKey(chunk)

	if strings.Contains(lower, "baseline model quota reached") ||
		strings.Contains(lower, "quota reached") ||
		strings.Contains(lower, "quota_exhausted") ||
		strings.Contains(lower, "resource_exhausted") {
		return "quota", mk, extractQuotaResetDelayMs(chunk)
	}
	if strings.Contains(lower, "model_capacity_exhausted") ||
		strings.Contains(lower, "no capacity available") ||
		strings.Contains(lower, "capacity available for model") {
		return "capacity", mk, extractQuotaResetDelayMs(chunk)
	}
	return "", "", 0
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
}

// getErrorSnippet truncates error text for report payloads (max 1200 chars).
func getErrorSnippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 1200 {
		return text[:1200]
	}
	return text
}

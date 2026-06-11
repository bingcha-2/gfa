package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// ═══════════════════════════════════════════════════════════════════════════
// Path detection helpers
// ═══════════════════════════════════════════════════════════════════════════

func isGenerationRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ":streamgeneratecontent") ||
		strings.Contains(lower, ":generatecontent") ||
		strings.Contains(lower, "streamgeneratecontent") ||
		strings.Contains(lower, "generatecontent") ||
		strings.Contains(lower, "bidigeneratecontent")
}

func isCloudCodeRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "/v1internal") ||
		strings.Contains(lower, "v1internal:")
}

func upstreamEndpointForPath(path string) string {
	if isCloudCodeRequest(path) {
		return DefaultCloudEndpoint
	}
	return DefaultGeminiEndpoint
}

// cloudCodeEndpointForModel 按模型选 /v1internal 生成请求的上游 host:
//   - Gemini            → cloudcode-pa.googleapis.com
//   - Claude/GPT 等第三方 → daily-cloudcode-pa.googleapis.com(只在 daily 提供)
//
// 必要性:IDE 注入时把 cloudcode-pa 和 daily-cloudcode-pa 两个 host 都改写成了本地代理,
// 原始 host 丢失。若不按模型重路由,Claude/GPT 会被统一发到 cloudcode-pa → 403
// service_disabled / permission_denied(还会被误判成"验证挑战",绑定卡随即"繁忙")。
// modelKey 为空时回退到 cloudcode-pa(安全默认,等同旧行为)。
func cloudCodeEndpointForModel(modelKey string) string {
	if modelKey != "" && !isGeminiModel(modelKey) {
		return DailyCloudEndpoint
	}
	return DefaultCloudEndpoint
}

func isModelsRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ":fetchavailablemodels") || strings.Contains(lower, "fetchavailablemodels")
}

func isUndefinedEndpoint(path string) bool {
	lower := strings.ToLower(path)
	return lower == "/v1internal/undefined" || strings.HasSuffix(lower, "/undefined")
}

func isNoiseRequest(path string) bool {
	lower := strings.ToLower(path)
	// IDE 启动/保活类接口，直接返回 mock（不转发）
	// 注意：getUserInfo/onboardUser 等认证接口必须透传，不能 mock
	return strings.Contains(lower, "listexperiments") ||
		strings.Contains(lower, "cascadenuxes") ||
		strings.Contains(lower, "loadcodeassist") ||
		strings.Contains(lower, "fetchavailablemodels") ||
		strings.Contains(lower, "counttokens") ||
		strings.Contains(lower, "fetchadmincontrols") ||
		strings.Contains(lower, "recordcodeassistmetrics") ||
		strings.Contains(lower, "/client/metrics")
}

// isPassthroughRequest 认证相关请求：保留 IDE 原始 OAuth token 直接透传给 Google
// timo 也采用相同策略 — 不替换 token，不 mock
func isPassthroughRequest(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "getuserinfo") ||
		strings.Contains(lower, "onboarduser") ||
		strings.Contains(lower, "fetchuserinfo")
}

func ideFallbackPayload(path string) (interface{}, bool) {
	lower := strings.ToLower(path)
	if isModelsRequest(path) {
		return buildFallbackModels(), true
	}
	if strings.Contains(lower, "cascadenuxes") ||
		strings.Contains(lower, ":listexperiments") ||
		strings.Contains(lower, "listexperiments") ||
		strings.Contains(lower, ":counttokens") ||
		strings.Contains(lower, ":loadcodeassist") ||
		strings.Contains(lower, "loadcodeassist") ||
		strings.Contains(lower, "fetchadmincontrols") ||
		strings.Contains(lower, "recordcodeassistmetrics") ||
		strings.Contains(lower, "/client/metrics") {
		return map[string]interface{}{}, true
	}
	return nil, false
}

// ═══════════════════════════════════════════════════════════════════════════
// Project field handling
// ═══════════════════════════════════════════════════════════════════════════

// Check if project or projectId field exists anywhere in the JSON body
func hasProjectField(val interface{}) bool {
	switch v := val.(type) {
	case map[string]interface{}:
		for k, child := range v {
			if isProjectFieldName(k) {
				return true
			}
			if hasProjectField(child) {
				return true
			}
		}
	case []interface{}:
		for _, child := range v {
			if hasProjectField(child) {
				return true
			}
		}
	}
	return false
}

// Rewrite project and projectId fields
func rewriteProjectFields(val interface{}, projectId string) (interface{}, bool) {
	updated := false
	switch v := val.(type) {
	case map[string]interface{}:
		newMap := make(map[string]interface{})
		for k, child := range v {
			if isProjectFieldName(k) {
				newMap[k] = formatProjectId(child, projectId)
				updated = true
			} else {
				rewrittenChild, childUpdated := rewriteProjectFields(child, projectId)
				newMap[k] = rewrittenChild
				if childUpdated {
					updated = true
				}
			}
		}
		return newMap, updated
	case []interface{}:
		newList := make([]interface{}, len(v))
		for i, child := range v {
			rewrittenChild, childUpdated := rewriteProjectFields(child, projectId)
			newList[i] = rewrittenChild
			if childUpdated {
				updated = true
			}
		}
		return newList, updated
	}
	return val, updated
}

func isProjectFieldName(key string) bool {
	return key == "project" || key == "projectId"
}

func formatProjectId(current interface{}, target string) string {
	currStr, ok := current.(string)
	if !ok {
		return target
	}
	currStr = strings.TrimSpace(currStr)
	if currStr == "" {
		return target
	}
	if strings.HasPrefix(strings.ToLower(currStr), "projects/") {
		return "projects/" + target
	}
	return target
}

// ═══════════════════════════════════════════════════════════════════════════
// Model key extraction
// ═══════════════════════════════════════════════════════════════════════════

// extractModelKeyFromPath 从 URL 路径提取模型名
// 例如: /v1beta/models/gemini-2.5-pro:streamGenerateContent → gemini-2.5-pro
func extractModelKeyFromPath(path string) string {
	re := regexp.MustCompile(`models/([^/:]+)`)
	matches := re.FindStringSubmatch(path)
	if len(matches) >= 2 {
		return matches[1]
	}
	return ""
}

// extractModelKeyFromBody parses the JSON request body and recursively finds
// the first "model" string field — same behavior as the extension's
// extractModelKeyFromBody (token-proxy.js L554-566).
func extractModelKeyFromBody(body []byte) string {
	var parsed interface{}
	if json.Unmarshal(body, &parsed) != nil {
		return ""
	}
	return findFirstStringByKey(parsed, "model")
}

func findFirstStringByKey(v interface{}, key string) string {
	switch val := v.(type) {
	case map[string]interface{}:
		if s, ok := val[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
		for _, child := range val {
			if r := findFirstStringByKey(child, key); r != "" {
				return r
			}
		}
	case []interface{}:
		for _, item := range val {
			if r := findFirstStringByKey(item, key); r != "" {
				return r
			}
		}
	}
	return ""
}

// ═══════════════════════════════════════════════════════════════════════════
// Response body helpers
// ═══════════════════════════════════════════════════════════════════════════

func readAndResetResponseBody(resp *http.Response) []byte {
	if resp == nil || resp.Body == nil {
		return nil
	}
	respBytes, _ := io.ReadAll(resp.Body)
	resp.Body = io.NopCloser(bytes.NewReader(respBytes))
	return respBytes
}

// debugResponseBody 将响应体转换为可读的日志字符串
// 自动解压 gzip，截断到 maxLen 字符，过滤不可打印字符
func debugResponseBody(data []byte, contentEncoding string, maxLen int) string {
	readable := data
	// 尝试 gzip 解压
	if strings.Contains(strings.ToLower(contentEncoding), "gzip") || (len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b) {
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err == nil {
			decompressed, err := io.ReadAll(r)
			_ = r.Close()
			if err == nil {
				readable = decompressed
			}
		}
	}
	s := string(readable)
	if len(s) > maxLen {
		s = s[:maxLen] + "..."
	}
	return s
}

func accountIdsFromSet(values map[int]bool) []int {
	ids := make([]int, 0, len(values))
	for id := range values {
		if id > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

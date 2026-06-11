package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// 硬额度超限阈值:服务端 429 的 retryAfterMs 超过它 → 判定为「卡额度已用完」(窗口级,短重试
// 无用);低于它 → 秒级临时限额。三家 leaser 共用同一阈值与判定。
const hardLimitRetryThresholdMs = 10 * 60 * 1000 // 10min

// QuotaExhaustedError 表示「卡额度已用完」这种硬限额失败:窗口内不会恢复,客户端绝不重试,
// 由 proxy 转成给 IDE 的 429 + Retry-After,让 IDE 自己退避(而不是当 502 临时故障狂试)。
type QuotaExhaustedError struct {
	RetryAfterMs int64
	Reason       string // 服务端精简文案,如 "...token limit exceeded (130973/100000 tokens/5h)"
}

func (e *QuotaExhaustedError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("卡额度已用完,约 %s 后恢复", humanizeMs(e.RetryAfterMs))
	}
	return fmt.Sprintf("卡额度已用完:%s,约 %s 后恢复", e.Reason, humanizeMs(e.RetryAfterMs))
}

// RetryAfterSeconds 给 proxy 写 Retry-After header(秒,至少 1)。
func (e *QuotaExhaustedError) RetryAfterSeconds() int {
	s := (e.RetryAfterMs + 999) / 1000
	if s < 1 {
		s = 1
	}
	return int(s)
}

// parseQuota429 从远端 429/失败 body 提取 retryAfterMs 与精简额度文案。
func parseQuota429(body []byte) (retryAfterMs int64, reason string) {
	var r struct {
		Error        string `json:"error"`
		Message      string `json:"message"`
		RetryAfterMs int64  `json:"retryAfterMs"`
	}
	_ = json.Unmarshal(body, &r)
	reason = r.Error
	if reason == "" {
		reason = r.Message
	}
	return r.RetryAfterMs, reason
}

// isHardQuotaLimit:retryAfter 达阈值,或文案明确是卡级 token 上限超限 = 硬额度(窗口级,短重试
// 无用)。前者覆盖带 retryAfterMs 的 429(claude/codex);后者覆盖只给文案的场景(antigravity 走
// success=false,可能不带 retryAfterMs)。"token limit exceeded" 来自服务端的额度 enforce,不是流内容。
func isHardQuotaLimit(retryAfterMs int64, reason string) bool {
	if retryAfterMs >= hardLimitRetryThresholdMs {
		return true
	}
	return strings.Contains(reason, "token limit exceeded")
}

// humanizeMs 把毫秒格式化成「Xh Ym」/「Zm」的人话恢复时间。
func humanizeMs(ms int64) string {
	totalMin := (ms + 59_999) / 60_000
	if totalMin <= 0 {
		return "稍后"
	}
	h := totalMin / 60
	m := totalMin % 60
	if h > 0 {
		if m > 0 {
			return fmt.Sprintf("%dh%dm", h, m)
		}
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dm", m)
}

// writeQuotaExhausted:若 err 是 QuotaExhaustedError(卡额度用完),给下游 IDE 写标准
// 429 + Retry-After(真实恢复秒数)+ Anthropic 风格 rate_limit_error 体,让 IDE 据此退避/停;
// 返回 true 表示已处理。否则返回 false,调用方按普通错误(502)处理。
// 三家 proxy(claude/codex/antigravity)共用,统一「额度用完 → 429 让 IDE 停」而非「502 让它狂试」。
func writeQuotaExhausted(w http.ResponseWriter, err error) bool {
	var qe *QuotaExhaustedError
	if !errors.As(err, &qe) {
		return false
	}
	w.Header().Set("Retry-After", strconv.Itoa(qe.RetryAfterSeconds()))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"type": "error",
		"error": map[string]interface{}{
			"type":    "rate_limit_error",
			"message": qe.Error(),
		},
	})
	return true
}

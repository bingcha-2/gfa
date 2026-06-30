package codexbiz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// ResetCredit 是一条主动重置次数记录(照搬 CodexResetCredit)。
type ResetCredit struct {
	ID         string `json:"id,omitempty"`
	Status     string `json:"status,omitempty"`
	ResetType  string `json:"reset_type,omitempty"`
	GrantedAt  *int64 `json:"granted_at,omitempty"`
	ExpiresAt  *int64 `json:"expires_at,omitempty"`
	RedeemedAt *int64 `json:"redeemed_at,omitempty"`
	RawStatus  string `json:"raw_status,omitempty"`
}

// ResetCreditsSnapshot 是主动重置次数明细(照搬 CodexResetCreditsSnapshot)。
type ResetCreditsSnapshot struct {
	AvailableCount *int64        `json:"available_count,omitempty"`
	Credits        []ResetCredit `json:"credits"`
	NextExpiresAt  *int64        `json:"next_expires_at,omitempty"`
}

// GetResetCredits 照搬 cockpit fetch_reset_credits:GET wham/rate-limit-reset-credits。
func (c *Client) GetResetCredits(acc Account) (ResetCreditsSnapshot, error) {
	req, err := http.NewRequest(http.MethodGet, c.ep.ResetCreditsURL, nil)
	if err != nil {
		return ResetCreditsSnapshot{}, err
	}
	buildCodexAPIHeaders(req, acc)

	body, status, err := c.do(req, "请求主动重置次数明细失败", "读取主动重置次数明细响应失败")
	if err != nil {
		return ResetCreditsSnapshot{}, err
	}
	if status/100 != 2 {
		return ResetCreditsSnapshot{}, httpError("主动重置次数明细接口返回错误", status, body)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return ResetCreditsSnapshot{}, fmt.Errorf("主动重置次数明细 JSON 解析失败: %w", err)
	}
	return parseResetCreditsSnapshot(payload), nil
}

// ConsumeResetCredit 照搬 cockpit post_reset_credit_once:
// POST wham/rate-limit-reset-credits/consume,body={redeem_request_id}。
// redeemRequestID 为空时生成一个新的 UUID(对齐 consume_reset_credit 的 uuid::new_v4)。
func (c *Client) ConsumeResetCredit(acc Account, redeemRequestID string) error {
	if strings.TrimSpace(redeemRequestID) == "" {
		redeemRequestID = uuid.NewString()
	}
	payload, _ := json.Marshal(map[string]string{"redeem_request_id": redeemRequestID})
	req, err := http.NewRequest(http.MethodPost, c.ep.ResetCreditsConsumeURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	buildCodexAPIHeaders(req, acc)

	body, status, err := c.do(req, "请求主动重置失败", "读取主动重置响应失败")
	if err != nil {
		return err
	}
	if status/100 == 2 {
		return nil
	}
	return httpError("主动重置接口返回错误", status, body)
}

// ── 解析(照搬 parse_reset_credits_snapshot / parse_reset_credit_record）──

func parseResetCreditsSnapshot(payload map[string]any) ResetCreditsSnapshot {
	creditsRaw := arrayField(payload, "credits")
	if creditsRaw == nil {
		if data, ok := payload["data"].(map[string]any); ok {
			creditsRaw = arrayField(data, "credits")
		}
	}

	var credits []ResetCredit
	for _, item := range creditsRaw {
		if rec, ok := item.(map[string]any); ok {
			if credit, ok := parseResetCreditRecord(rec); ok {
				credits = append(credits, credit)
			}
		}
	}

	available := readResetAvailableCount(payload)
	if available == nil {
		count := int64(0)
		for i := range credits {
			if isAvailableResetCredit(&credits[i]) {
				count++
			}
		}
		available = &count
	}

	var nextExpires *int64
	for i := range credits {
		if !isAvailableResetCredit(&credits[i]) || credits[i].ExpiresAt == nil {
			continue
		}
		if nextExpires == nil || *credits[i].ExpiresAt < *nextExpires {
			v := *credits[i].ExpiresAt
			nextExpires = &v
		}
	}

	return ResetCreditsSnapshot{AvailableCount: available, Credits: credits, NextExpiresAt: nextExpires}
}

func readResetAvailableCount(payload map[string]any) *int64 {
	if v := readInt64Scalar(payload, "available_count", "availableCount"); v != nil {
		return v
	}
	if data, ok := payload["data"].(map[string]any); ok {
		return readInt64Scalar(data, "available_count", "availableCount")
	}
	return nil
}

func parseResetCreditRecord(record map[string]any) (ResetCredit, bool) {
	rawStatus := extractRecordField(record, "status", "state")
	expiresAt := extractResetTimestamp(record, "expires_at", "expire_at", "expiresAt")
	status := normalizeResetCreditStatus(rawStatus, expiresAt)

	return ResetCredit{
		ID:         extractRecordField(record, "id", "credit_id", "creditId"),
		Status:     status,
		ResetType:  extractRecordField(record, "type", "reset_type", "resetType"),
		GrantedAt:  extractResetTimestamp(record, "granted_at", "created_at", "grantedAt"),
		ExpiresAt:  expiresAt,
		RedeemedAt: extractResetTimestamp(record, "redeemed_at", "used_at", "consumed_at", "redeemedAt"),
		RawStatus:  rawStatus,
	}, true
}

// normalizeResetCreditStatus 照搬 normalize_reset_credit_status:
// 有显式状态 -> 小写;否则若已过期 -> "expired";否则空。
func normalizeResetCreditStatus(status string, expiresAt *int64) string {
	if s := normalizeOptional(status); s != "" {
		return strings.ToLower(s)
	}
	if expiresAt != nil && *expiresAt <= nowUnix() {
		return "expired"
	}
	return ""
}

// isAvailableResetCredit 照搬 is_available_reset_credit。
func isAvailableResetCredit(credit *ResetCredit) bool {
	status := credit.Status
	if status == "" {
		status = credit.RawStatus
	}
	if status == "" {
		status = "available"
	}
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "redeemed", "used", "consumed", "expired":
		return false
	}
	if credit.ExpiresAt != nil {
		return *credit.ExpiresAt > nowUnix()
	}
	return true
}

// extractResetTimestamp 照搬 extract_reset_credit_timestamp:
// 数值(>1e12 视为毫秒,除 1000)或 RFC3339 / 数字字符串。
func extractResetTimestamp(record map[string]any, keys ...string) *int64 {
	for _, k := range keys {
		v, ok := record[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case json.Number:
			if n, err := t.Int64(); err == nil {
				return normalizeMaybeMillis(n)
			}
			if f, err := t.Float64(); err == nil {
				return normalizeMaybeMillis(int64(f))
			}
		case float64:
			return normalizeMaybeMillis(int64(t))
		case string:
			if ts, ok := parseSubscriptionTimestamp(t); ok {
				return &ts
			}
		}
	}
	return nil
}

func normalizeMaybeMillis(ts int64) *int64 {
	if ts > 1_000_000_000_000 {
		ts /= 1000
	}
	return &ts
}

func arrayField(m map[string]any, key string) []any {
	if v, ok := m[key].([]any); ok {
		return v
	}
	return nil
}

func readInt64Scalar(m map[string]any, keys ...string) *int64 {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case json.Number:
			if n, err := t.Int64(); err == nil {
				return &n
			}
		case float64:
			n := int64(t)
			return &n
		}
	}
	return nil
}

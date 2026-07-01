package codexbiz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// ReferralInviteEligibility 照搬 CodexReferralInviteEligibility。
type ReferralInviteEligibility struct {
	ShouldShow           bool   `json:"should_show"`
	RemainingReferrals   *int64 `json:"remaining_referrals,omitempty"`
	IneligibleReasonCode string `json:"ineligible_reason_code,omitempty"`
	GrantAction          string `json:"grant_action,omitempty"`
	GrantAmount          *int64 `json:"grant_amount,omitempty"`
	ReferralKey          string `json:"referral_key"`
}

// ReferralTimeFrameRule 照搬 CodexReferralTimeFrameRule。
type ReferralTimeFrameRule struct {
	RuleType     string `json:"type"`
	InvitesSent  int64  `json:"invites_sent"`
	InvitesTotal int64  `json:"invites_total"`
}

// ReferralEligibilityRules 照搬 CodexReferralEligibilityRules。
type ReferralEligibilityRules struct {
	RequiresExplicitConfirmation *bool                   `json:"requires_explicit_confirmation"`
	Rules                        []string                `json:"rules"`
	TimeFrameRules               []ReferralTimeFrameRule `json:"time_frame_rules"`
}

// ReferralInvite 照搬 CodexReferralInvite。
type ReferralInvite struct {
	Email string `json:"email"`
}

// ReferralInviteResponse 照搬 CodexReferralInviteResponse。
type ReferralInviteResponse struct {
	Invites []ReferralInvite `json:"invites"`
}

// ReferralEligibility 照搬 fetch_referral_invite_eligibility_once:
// GET referrals/invite/eligibility?referral_key=...
func (c *Client) ReferralEligibility(acc Account, referralKey string) (ReferralInviteEligibility, error) {
	key := normalizeReferralKey(referralKey)
	body, status, err := c.getWithReferralKey(acc, c.ep.ReferralEligibilityURL, key, "请求 Codex 邀请资格失败", "读取 Codex 邀请资格响应失败")
	if err != nil {
		return ReferralInviteEligibility{}, err
	}
	if status/100 != 2 {
		return ReferralInviteEligibility{}, referralHTTPError("查询 Codex 邀请资格", status, body)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return ReferralInviteEligibility{}, fmt.Errorf("Codex 邀请资格 JSON 解析失败: %w", err)
	}
	return parseReferralInviteEligibility(payload, key), nil
}

// ReferralRules 照搬 fetch_referral_eligibility_rules_once:
// GET wham/referrals/eligibility_rules?referral_key=...
func (c *Client) ReferralRules(acc Account, referralKey string) (ReferralEligibilityRules, error) {
	key := normalizeReferralKey(referralKey)
	body, status, err := c.getWithReferralKey(acc, c.ep.ReferralRulesURL, key, "请求 Codex 邀请规则失败", "读取 Codex 邀请规则响应失败")
	if err != nil {
		return ReferralEligibilityRules{}, err
	}
	if status/100 != 2 {
		return ReferralEligibilityRules{}, referralHTTPError("查询 Codex 邀请规则", status, body)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return ReferralEligibilityRules{}, fmt.Errorf("Codex 邀请规则 JSON 解析失败: %w", err)
	}
	return parseReferralEligibilityRules(payload), nil
}

// SendReferralInvites 照搬 send_referral_invites + send_referral_invites_once:
// 清洗邮箱(trim/丢空),校验 1..=5,POST wham/referrals/invite。
func (c *Client) SendReferralInvites(acc Account, referralKey string, emails []string) (ReferralInviteResponse, error) {
	key := normalizeReferralKey(referralKey)
	cleaned := make([]string, 0, len(emails))
	for _, e := range emails {
		if t := strings.TrimSpace(e); t != "" {
			cleaned = append(cleaned, t)
		}
	}
	if len(cleaned) == 0 {
		return ReferralInviteResponse{}, fmt.Errorf("请至少填写一个邀请邮箱")
	}
	if len(cleaned) > 5 {
		return ReferralInviteResponse{}, fmt.Errorf("一次最多发送 5 个 Codex 邀请邮箱")
	}

	payload, _ := json.Marshal(map[string]any{"referral_key": key, "emails": cleaned})
	req, err := http.NewRequest(http.MethodPost, c.ep.ReferralInviteURL, bytes.NewReader(payload))
	if err != nil {
		return ReferralInviteResponse{}, err
	}
	buildCodexAPIHeaders(req, acc)

	body, status, err := c.do(req, "发送 Codex 邀请失败", "读取 Codex 邀请响应失败")
	if err != nil {
		return ReferralInviteResponse{}, err
	}
	if status/100 != 2 {
		return ReferralInviteResponse{}, referralHTTPError("发送 Codex 邀请", status, body)
	}
	var respPayload map[string]any
	if err := json.Unmarshal(body, &respPayload); err != nil {
		return ReferralInviteResponse{}, fmt.Errorf("Codex 邀请响应 JSON 解析失败: %w", err)
	}
	return parseReferralInviteResponse(respPayload), nil
}

func (c *Client) getWithReferralKey(acc Account, rawURL, key, sendErr, readErr string) ([]byte, int, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, 0, err
	}
	q := u.Query()
	q.Set("referral_key", key)
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	buildCodexAPIHeaders(req, acc)
	return c.do(req, sendErr, readErr)
}

// normalizeReferralKey 照搬 normalize_referral_key:trim 后空则回退默认 key。
func normalizeReferralKey(key string) string {
	if t := strings.TrimSpace(key); t != "" {
		return t
	}
	return DefaultReferralKey
}

// ── 解析 ──

func parseReferralInviteEligibility(payload map[string]any, referralKey string) ReferralInviteEligibility {
	return ReferralInviteEligibility{
		ShouldShow:           boolField(payload, "should_show"),
		RemainingReferrals:   int64PtrField(payload, "remaining_referrals"),
		IneligibleReasonCode: stringField(payload, "ineligible_reason_code"),
		GrantAction:          stringField(payload, "grant_action"),
		GrantAmount:          int64PtrField(payload, "grant_amount"),
		ReferralKey:          referralKey,
	}
}

func parseReferralEligibilityRules(payload map[string]any) ReferralEligibilityRules {
	var rules []string
	for _, item := range arrayField(payload, "rules") {
		if s, ok := item.(string); ok {
			if t := strings.TrimSpace(s); t != "" {
				rules = append(rules, t)
			}
		}
	}

	var timeFrame []ReferralTimeFrameRule
	for _, item := range arrayField(payload, "time_frame_rules") {
		rec, ok := item.(map[string]any)
		if !ok {
			continue
		}
		ruleType, ok := rec["type"].(string)
		if !ok || ruleType == "" {
			continue
		}
		timeFrame = append(timeFrame, ReferralTimeFrameRule{
			RuleType:     ruleType,
			InvitesSent:  int64OrZero(rec["invites_sent"]),
			InvitesTotal: int64OrZero(rec["invites_total"]),
		})
	}

	return ReferralEligibilityRules{
		RequiresExplicitConfirmation: boolPtrField(payload, "requires_explicit_confirmation"),
		Rules:                        rules,
		TimeFrameRules:               timeFrame,
	}
}

func parseReferralInviteResponse(payload map[string]any) ReferralInviteResponse {
	var invites []ReferralInvite
	for _, item := range arrayField(payload, "invites") {
		var email string
		switch t := item.(type) {
		case map[string]any:
			email, _ = t["email"].(string)
		case string:
			email = t
		}
		email = strings.TrimSpace(email)
		if email == "" {
			continue
		}
		invites = append(invites, ReferralInvite{Email: email})
	}
	return ReferralInviteResponse{Invites: invites}
}

// referralHTTPError 照搬 build_referral_http_error:
// 优先用 detail(string 或 message+failed_emails)拼人话错误,否则退回通用格式。
func referralHTTPError(action string, status int, body []byte) error {
	if detail := extractReferralErrorDetail(body); detail != "" {
		return fmt.Errorf("%s失败（HTTP %d）：%s", action, status, detail)
	}
	msg := fmt.Sprintf("%s接口返回错误 %d", action, status)
	if code := extractDetailCodeFromBody(body); code != "" {
		msg += fmt.Sprintf(" [error_code:%s]", code)
	}
	msg += fmt.Sprintf(" [body_len:%d]", len(body))
	return fmt.Errorf("%s", msg)
}

// extractReferralErrorDetail 照搬 extract_referral_error_detail。
func extractReferralErrorDetail(body []byte) string {
	var top struct {
		Detail json.RawMessage `json:"detail"`
	}
	if err := json.Unmarshal(body, &top); err != nil || len(top.Detail) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(top.Detail, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	var detail struct {
		Message      string   `json:"message"`
		FailedEmails []string `json:"failed_emails"`
	}
	if err := json.Unmarshal(top.Detail, &detail); err != nil {
		return ""
	}
	message := strings.TrimSpace(detail.Message)
	var failed []string
	for _, e := range detail.FailedEmails {
		if t := strings.TrimSpace(e); t != "" {
			failed = append(failed, t)
		}
	}
	switch {
	case message != "" && len(failed) > 0:
		return fmt.Sprintf("%s: %s", message, strings.Join(failed, ", "))
	case message != "":
		return message
	case len(failed) > 0:
		return strings.Join(failed, ", ")
	default:
		return ""
	}
}

// ── 小工具(map[string]any 取值)──

func boolField(m map[string]any, key string) bool {
	v, _ := m[key].(bool)
	return v
}

func boolPtrField(m map[string]any, key string) *bool {
	if v, ok := m[key].(bool); ok {
		return &v
	}
	return nil
}

func stringField(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func int64PtrField(m map[string]any, key string) *int64 {
	if v := int64OrNil(m[key]); v != nil {
		return v
	}
	return nil
}

func int64OrNil(v any) *int64 {
	switch t := v.(type) {
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return &n
		}
	case float64:
		n := int64(t)
		return &n
	}
	return nil
}

func int64OrZero(v any) int64 {
	if p := int64OrNil(v); p != nil {
		return *p
	}
	return 0
}

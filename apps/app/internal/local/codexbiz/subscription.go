package codexbiz

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// SubscriptionSnapshot 是订阅状态查询结果(照搬 SubscriptionStatusSnapshot)。
type SubscriptionSnapshot struct {
	AccountID               string
	PlanType                string
	SubscriptionActiveUntil string
}

// RefreshSubscription 照搬 cockpit fetch_subscription_status_snapshot:
// 先打 accounts/check;若返回的订阅缺失/过期,再回退打 subscriptions 并合并。
// 不含 token 刷新 / 持久化 / 重试(那些归编排层)。
func (c *Client) RefreshSubscription(acc Account) (SubscriptionSnapshot, error) {
	snap, err := c.fetchAccountCheck(acc)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	if !subscriptionMissingOrExpired(snap.SubscriptionActiveUntil) {
		return snap, nil
	}

	accountID := firstNonEmpty(snap.AccountID, normalizeOptional(acc.AccountID), extractChatGPTAccountID(acc.AccessToken))
	if accountID == "" {
		return SubscriptionSnapshot{}, fmt.Errorf("未获取到 account_id，无法请求 subscriptions")
	}

	subs, err := c.fetchSubscriptions(acc, accountID)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	snap.AccountID = accountID
	if subs.PlanType != "" {
		snap.PlanType = subs.PlanType
	}
	if subs.SubscriptionActiveUntil != "" {
		snap.SubscriptionActiveUntil = subs.SubscriptionActiveUntil
	}
	return snap, nil
}

func (c *Client) fetchAccountCheck(acc Account) (SubscriptionSnapshot, error) {
	const targetPath = "/backend-api/accounts/check/v4-2023-04-27"
	u, err := url.Parse(c.ep.AccountsCheckURL)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	q := u.Query()
	q.Set("timezone_offset_min", strconv.Itoa(chatGPTTimezoneOffsetMin()))
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	buildSubscriptionHeaders(req, acc, targetPath)

	body, status, err := c.do(req, "请求订阅账号信息失败", "读取订阅账号信息响应失败")
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	if status/100 != 2 {
		return SubscriptionSnapshot{}, httpError("订阅账号信息接口返回错误", status, body)
	}

	if !json.Valid(body) {
		return SubscriptionSnapshot{}, fmt.Errorf("订阅账号信息 JSON 解析失败: invalid JSON")
	}
	return parseAccountCheckSnapshot(body, acc)
}

func (c *Client) fetchSubscriptions(acc Account, accountID string) (SubscriptionSnapshot, error) {
	const targetPath = "/backend-api/subscriptions"
	u, err := url.Parse(c.ep.SubscriptionsURL)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	q := u.Query()
	q.Set("account_id", accountID)
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	buildSubscriptionHeaders(req, acc, targetPath)

	body, status, err := c.do(req, "请求订阅信息失败", "读取订阅信息响应失败")
	if err != nil {
		return SubscriptionSnapshot{}, err
	}
	if status/100 != 2 {
		return SubscriptionSnapshot{}, httpError("订阅信息接口返回错误", status, body)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return SubscriptionSnapshot{}, fmt.Errorf("订阅信息 JSON 解析失败: %w", err)
	}
	return parseSubscriptionSnapshot(payload, accountID), nil
}

// parseSubscriptionSnapshot 照搬 parse_subscription_snapshot:
// plan = subscription_plan|plan_type;active_until|expires_at。
func parseSubscriptionSnapshot(payload map[string]any, fallbackAccountID string) SubscriptionSnapshot {
	plan := normalizeJSONScalar(payload["subscription_plan"])
	if plan == "" {
		plan = normalizeJSONScalar(payload["plan_type"])
	}
	until := normalizeJSONScalar(payload["active_until"])
	if until == "" {
		until = normalizeJSONScalar(payload["expires_at"])
	}
	return SubscriptionSnapshot{
		AccountID:               normalizeOptional(fallbackAccountID),
		PlanType:                plan,
		SubscriptionActiveUntil: until,
	}
}

// parseAccountCheckSnapshot 照搬 parse_account_check_snapshot:
// 从 accounts(map 或 array)收集记录,优先匹配 preferred account_id /
// account_ordering[0],否则取第 0 条;从 entitlement / account 提取 plan 与 expires_at。
func parseAccountCheckSnapshot(body []byte, acc Account) (SubscriptionSnapshot, error) {
	var top struct {
		Accounts        json.RawMessage `json:"accounts"`
		AccountOrdering []string        `json:"account_ordering"`
	}
	_ = json.Unmarshal(body, &top)

	records := collectAccountRecords(top.Accounts, body)
	if len(records) == 0 {
		return SubscriptionSnapshot{}, fmt.Errorf("accounts/check 返回里没有可用账号")
	}

	preferred := firstNonEmpty(normalizeOptional(acc.AccountID), extractChatGPTAccountID(acc.AccessToken))
	var orderingFirst string
	if len(top.AccountOrdering) > 0 {
		orderingFirst = normalizeOptional(top.AccountOrdering[0])
	}

	selected := records[0]
	if preferred != "" {
		for _, rec := range records {
			if recordAccountID(rec.node) == preferred {
				selected = rec
				break
			}
		}
	}
	if recordAccountID(selected.node) != preferred && orderingFirst != "" {
		for _, rec := range records {
			if normalizeOptional(rec.key) == orderingFirst {
				selected = rec
				break
			}
		}
	}

	node := selected.node
	accountRec := node
	if sub, ok := node["account"].(map[string]any); ok {
		accountRec = sub
	}
	var entitlement map[string]any
	if ent, ok := node["entitlement"].(map[string]any); ok {
		entitlement = ent
	}

	accountID := extractRecordField(accountRec, "account_id", "id", "chatgpt_account_id", "workspace_id")
	plan := extractRecordField(entitlement, "subscription_plan")
	if plan == "" {
		plan = extractRecordField(accountRec, "plan_type", "planType")
	}
	until := extractRecordField(entitlement, "expires_at")
	if until == "" {
		until = extractRecordField(accountRec, "expires_at")
	}

	return SubscriptionSnapshot{AccountID: accountID, PlanType: plan, SubscriptionActiveUntil: until}, nil
}

type accountRecord struct {
	key  string
	node map[string]any
}

// collectAccountRecords 照搬 collect_subscription_account_records:
// accounts 为 array -> 无 key;为 object -> key=对象键;为空则尝试顶层 array。
func collectAccountRecords(accountsRaw json.RawMessage, body []byte) []accountRecord {
	var records []accountRecord
	if len(accountsRaw) > 0 {
		var asArray []map[string]any
		if err := json.Unmarshal(accountsRaw, &asArray); err == nil {
			for _, item := range asArray {
				records = append(records, accountRecord{node: item})
			}
		} else {
			var asObject map[string]map[string]any
			if err := json.Unmarshal(accountsRaw, &asObject); err == nil {
				for k, v := range asObject {
					records = append(records, accountRecord{key: k, node: v})
				}
			}
		}
	}
	if len(records) == 0 {
		var topArray []map[string]any
		if err := json.Unmarshal(body, &topArray); err == nil {
			for _, item := range topArray {
				records = append(records, accountRecord{node: item})
			}
		}
	}
	return records
}

func recordAccountID(node map[string]any) string {
	rec := node
	if sub, ok := node["account"].(map[string]any); ok {
		rec = sub
	}
	return extractRecordField(rec, "account_id", "id", "chatgpt_account_id", "workspace_id")
}

func extractRecordField(record map[string]any, keys ...string) string {
	if record == nil {
		return ""
	}
	for _, k := range keys {
		if v, ok := record[k]; ok {
			if s := normalizeJSONScalar(v); s != "" {
				return s
			}
		}
	}
	return ""
}

// ── 订阅时间判定(照搬 subscription_missing_or_expired / parse_subscription_timestamp）──

func subscriptionMissingOrExpired(raw string) bool {
	if normalizeOptional(raw) == "" {
		return true
	}
	ts, ok := parseSubscriptionTimestamp(raw)
	if !ok {
		return true
	}
	return ts <= nowUnix()
}

func parseSubscriptionTimestamp(raw string) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	if isAllDigits(trimmed) {
		ts, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return 0, false
		}
		if ts > 1_000_000_000_000 {
			ts /= 1000
		}
		return ts, true
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return 0, false
	}
	return parsed.Unix(), true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// chatGPTTimezoneOffsetMin 照搬 current_chatgpt_timezone_offset_min:
// -(本地相对 UTC 的偏移分钟)。
func chatGPTTimezoneOffsetMin() int {
	_, offsetSec := time.Now().Zone()
	return -(offsetSec / 60)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// do 发请求并读取 body + status(集中处理 transport 错误信息)。
func (c *Client) do(req *http.Request, sendErrPrefix, readErrPrefix string) ([]byte, int, error) {
	resp, err := c.doer.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%s: %w", sendErrPrefix, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("%s: %w", readErrPrefix, err)
	}
	return body, resp.StatusCode, nil
}

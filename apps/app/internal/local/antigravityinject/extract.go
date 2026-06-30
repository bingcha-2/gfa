package antigravityinject

import (
	"database/sql"
	"encoding/base64"
	"fmt"

	_ "modernc.org/sqlite"
)

// ExtractToken 是 InjectToPath 的逆:从一份 state.vscdb 读出 IDE 当前注入/登录的
// antigravity 自有号登录态(access/refresh/id_token/expiry/email/project)。
//
// 移植自 cockpit 的 sync(读 unified-state 三件套):
//   - oauthToken topic → oauthTokenInfoSentinelKey 行 → OAuthTokenInfo
//     (field 1=access_token, 3=refresh_token, 4=expiry{1:seconds}, 5=id_token)
//   - userStatus topic → userStatusSentinelKey 行 → payload field 3=email
//   - enterprisePreferences topic → enterpriseGcpProjectId 行 → payload field 3=project
func ExtractToken(dbPath string) (Token, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return Token{}, fmt.Errorf("打开数据库失败: %w", err)
	}
	defer db.Close()

	info, ok := readTopicPayload(db, keyOAuthToken, sentinelOAuthTokenInfo)
	if !ok {
		return Token{}, fmt.Errorf("antigravity IDE 未登录(无 oauthToken)")
	}
	tok := Token{}
	tok.AccessToken, _ = extractStringField(info, 1)
	tok.RefreshToken, _ = extractStringField(info, 3)
	tok.IDToken, _ = extractStringField(info, 5)
	tok.Expiry = extractExpirySeconds(info)
	if v, ok := extractVarintField(info, 6); ok {
		tok.IsGCPTos = v != 0
	}

	if status, ok := readTopicPayload(db, keyUserStatus, sentinelUserStatus); ok {
		tok.Email, _ = extractStringField(status, 3)
	}
	if pref, ok := readTopicPayload(db, keyEnterprisePreferences, sentinelEnterprise); ok {
		tok.ProjectID, _ = extractStringField(pref, 3)
	}
	if tok.AccessToken == "" {
		return Token{}, fmt.Errorf("antigravity IDE 登录态缺少 access_token")
	}
	return tok, nil
}

// readTopicPayload 读取某 ItemTable key 的 base64 topic,定位到 sentinelKey 行,
// 解码其 row(field 1=base64(payload))得到内部 protobuf payload。
func readTopicPayload(db *sql.DB, itemKey, sentinelKey string) ([]byte, bool) {
	b64 := readItem(db, itemKey)
	if b64 == "" {
		return nil, false
	}
	topic, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, false
	}
	entry, ok := topicEntryBySentinel(topic, sentinelKey)
	if !ok {
		return nil, false
	}
	return rowPayload(entry)
}

// topicEntryBySentinel 在 Topic.data(repeated field 1 = entry)里找 key==sentinel 的 entry。
func topicEntryBySentinel(topic []byte, sentinel string) ([]byte, bool) {
	offset := 0
	for offset < len(topic) {
		tag, n, ok := readVarint(topic, offset)
		if !ok {
			return nil, false
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == 1 && wt == 2 {
			length, co, ok := readVarint(topic, n)
			if !ok || co+int(length) > len(topic) {
				return nil, false
			}
			entry := topic[co : co+int(length)]
			if k, ok := unifiedTopicEntryKey(entry); ok && k == sentinel {
				return entry, true
			}
		}
		offset, ok = skipField(topic, n, wt)
		if !ok {
			return nil, false
		}
	}
	return nil, false
}

// rowPayload 从 entry { 1: sentinel, 2: row{1: base64(payload)} } 解出 payload。
func rowPayload(entry []byte) ([]byte, bool) {
	offset := 0
	for offset < len(entry) {
		tag, n, ok := readVarint(entry, offset)
		if !ok {
			return nil, false
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == 2 && wt == 2 {
			length, co, ok := readVarint(entry, n)
			if !ok || co+int(length) > len(entry) {
				return nil, false
			}
			row := entry[co : co+int(length)]
			b64, ok := extractStringField(row, 1)
			if !ok {
				return nil, false
			}
			payload, err := base64.StdEncoding.DecodeString(b64)
			return payload, err == nil
		}
		offset, ok = skipField(entry, n, wt)
		if !ok {
			return nil, false
		}
	}
	return nil, false
}

// extractExpirySeconds 取 OAuthTokenInfo field 4(Timestamp 嵌套消息),再取其 field 1(seconds)。
func extractExpirySeconds(data []byte) int64 {
	msg, ok := extractMessageField(data, 4)
	if !ok {
		return 0
	}
	if secs, ok := extractVarintField(msg, 1); ok {
		return int64(secs)
	}
	return 0
}

// extractMessageField 取指定 len-delimited 字段的原始字节(嵌套消息)。
func extractMessageField(data []byte, target uint32) ([]byte, bool) {
	offset := 0
	for offset < len(data) {
		tag, n, ok := readVarint(data, offset)
		if !ok {
			return nil, false
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == target && wt == 2 {
			length, co, ok := readVarint(data, n)
			if !ok || co+int(length) > len(data) {
				return nil, false
			}
			return data[co : co+int(length)], true
		}
		offset, ok = skipField(data, n, wt)
		if !ok {
			return nil, false
		}
	}
	return nil, false
}

// extractVarintField 取指定 varint 字段(wire_type 0)的值。
func extractVarintField(data []byte, target uint32) (uint64, bool) {
	offset := 0
	for offset < len(data) {
		tag, n, ok := readVarint(data, offset)
		if !ok {
			return 0, false
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == target && wt == 0 {
			val, _, ok := readVarint(data, n)
			return val, ok
		}
		offset, ok = skipField(data, n, wt)
		if !ok {
			return 0, false
		}
	}
	return 0, false
}

// extractStringField 从 protobuf 消息里取指定字段的字符串值。
func extractStringField(data []byte, target uint32) (string, bool) {
	offset := 0
	for offset < len(data) {
		tag, newOffset, ok := readVarint(data, offset)
		if !ok {
			return "", false
		}
		wireType := uint8(tag & 7)
		fieldNum := uint32(tag >> 3)
		if fieldNum == target && wireType == 2 {
			length, contentOffset, ok := readVarint(data, newOffset)
			if !ok || contentOffset+int(length) > len(data) {
				return "", false
			}
			return string(data[contentOffset : contentOffset+int(length)]), true
		}
		offset, ok = skipField(data, newOffset, wireType)
		if !ok {
			return "", false
		}
	}
	return "", false
}

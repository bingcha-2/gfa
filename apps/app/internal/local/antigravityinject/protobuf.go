// Package antigravityinject 把本地自有 antigravity 号的 token 直接写进 Antigravity
// IDE 的 state.vscdb(sqlite),让 IDE 以该号的官方登录态运行 —— 不经任何网关/反代。
//
// 二进制编码逐字对齐 cockpit-core(crates/cockpit-core/src/utils/protobuf.rs +
// modules/db.rs 的 inject_token_to_path_with_metadata):antigravityUnifiedStateSync.*
// 这几个 ItemTable key 写的是 protobuf-over-base64 的 Topic 结构。
package antigravityinject

// encodeVarint 编码 protobuf varint。
func encodeVarint(value uint64) []byte {
	var buf []byte
	for value >= 0x80 {
		buf = append(buf, byte(value&0x7F|0x80))
		value >>= 7
	}
	return append(buf, byte(value))
}

// encodeLenDelimField 编码长度分隔字段 (wire_type = 2)。
func encodeLenDelimField(fieldNum uint32, data []byte) []byte {
	tag := (fieldNum << 3) | 2
	f := encodeVarint(uint64(tag))
	f = append(f, encodeVarint(uint64(len(data)))...)
	return append(f, data...)
}

// encodeStringField 编码字符串字段 (wire_type = 2)。
func encodeStringField(fieldNum uint32, value string) []byte {
	return encodeLenDelimField(fieldNum, []byte(value))
}

// encodeVarintField 编码 varint 字段 (wire_type = 0)。
func encodeVarintField(fieldNum uint32, value uint64) []byte {
	tag := (fieldNum << 3) | 0
	field := encodeVarint(uint64(tag))
	return append(field, encodeVarint(value)...)
}

// readVarint 读取 protobuf varint,返回值与新偏移。
func readVarint(data []byte, offset int) (uint64, int, bool) {
	var result uint64
	var shift uint
	pos := offset
	for {
		if pos >= len(data) {
			return 0, 0, false
		}
		b := data[pos]
		result |= uint64(b&0x7F) << shift
		pos++
		if b&0x80 == 0 {
			break
		}
		shift += 7
	}
	return result, pos, true
}

// skipField 跳过一个 protobuf 字段,返回字段结束后的偏移。
// 所有分支都校验结束偏移落在 data 内:截断/损坏的 topic(IDE 半写、schema 漂移)
// 若返回越界 offset 且 ok=true,调用方(removeUnifiedTopicEntry)会 data[start:end] panic。
func skipField(data []byte, offset int, wireType uint8) (int, bool) {
	switch wireType {
	case 0:
		_, n, ok := readVarint(data, offset)
		return n, ok
	case 1:
		if offset+8 > len(data) {
			return 0, false
		}
		return offset + 8, true
	case 2:
		length, contentOffset, ok := readVarint(data, offset)
		if !ok {
			return 0, false
		}
		end := contentOffset + int(length)
		if length < 0 || end > len(data) {
			return 0, false
		}
		return end, true
	case 5:
		if offset+4 > len(data) {
			return 0, false
		}
		return offset + 4, true
	default:
		return 0, false
	}
}

// createOAuthInfoWithMetadata 构造 OAuthTokenInfo 消息(对齐 cockpit)。
func createOAuthInfoWithMetadata(accessToken, refreshToken string, expiry int64, isGCPTos bool, idToken, email string) []byte {
	if email != "" {
		lower := toLowerASCII(email)
		if hasSuffix(lower, "@gmail.com") || hasSuffix(lower, "@googlemail.com") {
			isGCPTos = false
		}
	}

	out := make([]byte, 0, 256)
	out = append(out, encodeStringField(1, accessToken)...)  // access_token
	out = append(out, encodeStringField(2, "Bearer")...)     // token_type
	out = append(out, encodeStringField(3, refreshToken)...) // refresh_token

	// Field 4: expiry 嵌套 Timestamp 消息 { 1: seconds(varint), 2: nanos(0) }
	timestampTag := uint64((1 << 3) | 0)
	timestampMsg := encodeVarint(timestampTag)
	timestampMsg = append(timestampMsg, encodeVarint(uint64(expiry))...)
	timestampMsg = append(timestampMsg, encodeVarintField(2, 0)...)
	out = append(out, encodeLenDelimField(4, timestampMsg)...)

	if idToken != "" {
		out = append(out, encodeStringField(5, idToken)...)
	}
	if isGCPTos {
		out = append(out, encodeVarintField(6, 1)...)
	}
	return out
}

// createUnifiedTopicEntry 构造 unified-state Topic.data entry。
func createUnifiedTopicEntry(sentinelKey string, payload []byte) []byte {
	row := encodeStringField(1, base64Std(payload))
	entry := append(encodeStringField(1, sentinelKey), encodeLenDelimField(2, row)...)
	return encodeLenDelimField(1, entry)
}

// createStringValuePayload 构造 unified-state stringValue payload。
func createStringValuePayload(value string) []byte {
	return encodeStringField(3, value)
}

// createMinimalUserStatusPayload 构造最小可用 UserStatus payload。
func createMinimalUserStatusPayload(email string) []byte {
	return append(encodeStringField(3, email), encodeStringField(7, email)...)
}

// removeUnifiedTopicEntry 从 Topic.data 移除指定 map entry,保留其它 sentinel row。
func removeUnifiedTopicEntry(data []byte, targetKey string) ([]byte, bool) {
	var result []byte
	offset := 0
	for offset < len(data) {
		startOffset := offset
		tag, newOffset, ok := readVarint(data, offset)
		if !ok {
			return nil, false
		}
		wireType := uint8(tag & 7)
		fieldNum := uint32(tag >> 3)
		nextOffset, ok := skipField(data, newOffset, wireType)
		if !ok {
			return nil, false
		}

		shouldRemove := false
		if fieldNum == 1 && wireType == 2 {
			length, contentOffset, ok := readVarint(data, newOffset)
			if !ok || contentOffset+int(length) > len(data) {
				return nil, false
			}
			entry := data[contentOffset : contentOffset+int(length)]
			if k, ok := unifiedTopicEntryKey(entry); ok && k == targetKey {
				shouldRemove = true
			}
		}
		if !shouldRemove {
			result = append(result, data[startOffset:nextOffset]...)
		}
		offset = nextOffset
	}
	return result, true
}

func unifiedTopicEntryKey(data []byte) (string, bool) {
	offset := 0
	for offset < len(data) {
		tag, newOffset, ok := readVarint(data, offset)
		if !ok {
			return "", false
		}
		wireType := uint8(tag & 7)
		fieldNum := uint32(tag >> 3)
		if fieldNum == 1 && wireType == 2 {
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

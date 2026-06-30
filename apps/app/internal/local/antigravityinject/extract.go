package antigravityinject

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

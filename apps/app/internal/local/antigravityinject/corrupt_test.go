package antigravityinject

import (
	"encoding/base64"
	"testing"
)

// 回归:state.vscdb 里已存的 oauthToken 若截断/损坏(IDE 半写、schema 漂移),
// 注入要解码它并 removeUnifiedTopicEntry —— 旧 skipField 对越界 wire-type-2 返回 ok=true,
// 后续 data[start:end] 切片越界 panic。修复后必须优雅处理、不崩。
func TestInject_CorruptExistingOAuthTokenNoPanic(t *testing.T) {
	corruptTopics := [][]byte{
		{0x0A},                         // field1 wiretype2,缺 length varint
		{0x0A, 0xFF},                   // length varint 不完整
		{0x0A, 0x7F},                   // 声称 127 字节但后面没有
		{0x0A, 0xFF, 0xFF, 0xFF, 0x0F}, // 巨大 length 远超剩余
		{0x09},                         // field1 wiretype1(固定8字节)但无数据
		{0x0D, 0x01},                   // wiretype5(固定4字节)但不足
	}
	for i, raw := range corruptTopics {
		path, db := openTestDB(t)
		if _, err := db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, keyOAuthToken, base64.StdEncoding.EncodeToString(raw)); err != nil {
			t.Fatalf("seed[%d]: %v", i, err)
		}
		_ = db.Close()
		// 不能 panic;能否成功取决于损坏程度,但绝不允许崩。
		_ = InjectToPath(path, Token{AccessToken: "AT", RefreshToken: "RT", Email: "x@y.com"})
	}
}

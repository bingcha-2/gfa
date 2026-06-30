package antigravityinject

import (
	"database/sql"
	"encoding/base64"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func openTestDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.vscdb")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	return path, db
}

// 解出 oauthToken topic 里 oauthTokenInfoSentinelKey 行的 OAuthTokenInfo,再取 field。
func decodeOAuthInfo(t *testing.T, db *sql.DB) []byte {
	t.Helper()
	b64 := readItem(db, keyOAuthToken)
	if b64 == "" {
		t.Fatal("oauthToken not written")
	}
	topic, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("topic b64: %v", err)
	}
	// Topic.data: repeated field 1 = entry { 1: sentinel, 2: row{1: b64(payload)} }
	offset := 0
	for offset < len(topic) {
		tag, n, ok := readVarint(topic, offset)
		if !ok {
			t.Fatal("varint")
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == 1 && wt == 2 {
			length, co, _ := readVarint(topic, n)
			entry := topic[co : co+int(length)]
			key, _ := unifiedTopicEntryKey(entry)
			if key == sentinelOAuthTokenInfo {
				row, ok := extractRowPayload(entry)
				if !ok {
					t.Fatal("row payload")
				}
				return row
			}
		}
		offset, _ = skipField(topic, n, wt)
	}
	t.Fatal("oauth sentinel not found")
	return nil
}

// entry { 1: sentinel, 2: row }; row { 1: base64(payload) } -> 返回 decoded payload。
func extractRowPayload(entry []byte) ([]byte, bool) {
	offset := 0
	for offset < len(entry) {
		tag, n, ok := readVarint(entry, offset)
		if !ok {
			return nil, false
		}
		wt := uint8(tag & 7)
		fn := uint32(tag >> 3)
		if fn == 2 && wt == 2 {
			length, co, _ := readVarint(entry, n)
			row := entry[co : co+int(length)]
			b64, ok := extractStringField(row, 1)
			if !ok {
				return nil, false
			}
			payload, err := base64.StdEncoding.DecodeString(b64)
			return payload, err == nil
		}
		offset, _ = skipField(entry, n, wt)
	}
	return nil, false
}

func TestInject_WritesDecodableOAuthToken(t *testing.T) {
	path, db := openTestDB(t)
	tok := Token{
		AccessToken: "AT123", RefreshToken: "RT456", Expiry: 1893456000,
		IDToken: "IDTOK", Email: "user@example.com", ProjectID: "proj-1", IsGCPTos: true,
	}
	if err := InjectToPath(path, tok); err != nil {
		t.Fatalf("InjectToPath: %v", err)
	}

	info := decodeOAuthInfo(t, db)
	if at, _ := extractStringField(info, 1); at != "AT123" {
		t.Fatalf("access_token=%q", at)
	}
	if tt, _ := extractStringField(info, 2); tt != "Bearer" {
		t.Fatalf("token_type=%q", tt)
	}
	if rt, _ := extractStringField(info, 3); rt != "RT456" {
		t.Fatalf("refresh_token=%q", rt)
	}
	if idt, _ := extractStringField(info, 5); idt != "IDTOK" {
		t.Fatalf("id_token=%q", idt)
	}

	// 企业号:enterprisePreferences 应写入;onboarding 标记应为 true。
	if readItem(db, keyEnterprisePreferences) == "" {
		t.Fatal("enterprise preference not written for project account")
	}
	if readItem(db, keyOnboarding) != "true" {
		t.Fatal("onboarding flag not set")
	}
	if readItem(db, keyUserStatus) == "" {
		t.Fatal("user status not written")
	}
}

// gmail 个人号:is_gcp_tos 强制 false,且无 project 时 enterprise preference 清空。
func TestInject_GmailClearsGCPTosAndEnterprise(t *testing.T) {
	path, db := openTestDB(t)
	// 预置一条 enterprise preference,验证会被清理。
	_, _ = db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, keyEnterprisePreferences, "stale")
	tok := Token{AccessToken: "AT", RefreshToken: "RT", Expiry: 1, Email: "p@gmail.com", IsGCPTos: true}
	if err := InjectToPath(path, tok); err != nil {
		t.Fatalf("InjectToPath: %v", err)
	}
	info := decodeOAuthInfo(t, db)
	// is_gcp_tos (field 6) 不应出现(gmail 强制 false → 不编码)。
	if _, ok := extractStringField(info, 6); ok {
		t.Fatal("gmail account should not carry is_gcp_tos")
	}
	if readItem(db, keyEnterprisePreferences) != "" {
		t.Fatal("enterprise preference should be cleared for personal account")
	}
}

// Restore 应清掉 unified-state 三件套。
func TestRestore_ClearsUnifiedState(t *testing.T) {
	path, db := openTestDB(t)
	if err := InjectToPath(path, Token{AccessToken: "AT", RefreshToken: "RT", Email: "e@x.com", ProjectID: "p"}); err != nil {
		t.Fatalf("inject: %v", err)
	}
	if err := RestorePath(path); err != nil {
		t.Fatalf("restore: %v", err)
	}
	for _, k := range []string{keyOAuthToken, keyUserStatus, keyEnterprisePreferences} {
		if readItem(db, k) != "" {
			t.Fatalf("key %s should be cleared", k)
		}
	}
}

// 重复注入:已有 oauthToken topic 时应替换 oauth sentinel 行而非追加重复。
func TestInject_ReplacesExistingSentinel(t *testing.T) {
	path, db := openTestDB(t)
	if err := InjectToPath(path, Token{AccessToken: "A1", RefreshToken: "R1", Email: "e@x.com"}); err != nil {
		t.Fatalf("inject1: %v", err)
	}
	if err := InjectToPath(path, Token{AccessToken: "A2", RefreshToken: "R2", Email: "e@x.com"}); err != nil {
		t.Fatalf("inject2: %v", err)
	}
	info := decodeOAuthInfo(t, db)
	if at, _ := extractStringField(info, 1); at != "A2" {
		t.Fatalf("expected latest access_token A2, got %q", at)
	}
}

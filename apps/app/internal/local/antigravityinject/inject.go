package antigravityinject

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

// ItemTable key 常量(对齐 cockpit-core db.rs)。
const (
	keyOAuthToken            = "antigravityUnifiedStateSync.oauthToken"
	keyUserStatus            = "antigravityUnifiedStateSync.userStatus"
	keyEnterprisePreferences = "antigravityUnifiedStateSync.enterprisePreferences"
	keyAgentManagerInitState = "jetskiStateSync.agentManagerInitState"
	keyOnboarding            = "antigravityOnboarding"

	sentinelOAuthTokenInfo = "oauthTokenInfoSentinelKey"
	sentinelUserStatus     = "userStatusSentinelKey"
	sentinelEnterprise     = "enterpriseGcpProjectId"
)

// Token 是注入所需的一份 antigravity 自有号登录态。
type Token struct {
	AccessToken  string
	RefreshToken string
	Expiry       int64 // unix 秒
	IDToken      string
	Email        string
	ProjectID    string // Google Cloud project(企业号);空=个人号
	IsGCPTos     bool
}

// InjectToPath 把一份 token 写进指定 state.vscdb,逐字对齐 cockpit 的
// inject_token_to_path_with_metadata。dbPath 必须是已存在的 sqlite 文件。
func InjectToPath(dbPath string, t Token) error {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	defer db.Close()

	if err := injectUnifiedOAuthToken(db, t); err != nil {
		return err
	}
	if email := strings.TrimSpace(t.Email); email != "" {
		if err := injectUserStatus(db, email); err != nil {
			return err
		}
	}
	if project := strings.TrimSpace(t.ProjectID); project != "" {
		if err := injectEnterpriseProjectPreference(db, project); err != nil {
			return err
		}
	} else if err := clearEnterpriseProjectPreference(db); err != nil {
		return err
	}

	// Onboarding 标记:删旧 init state + 置 onboarding=true。
	_, _ = db.Exec(`DELETE FROM ItemTable WHERE key = ?`, keyAgentManagerInitState)
	if _, err := db.Exec(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, keyOnboarding, "true"); err != nil {
		return fmt.Errorf("写入 Onboarding 标记失败: %w", err)
	}
	return nil
}

// RestorePath 移除注入(对齐「还原」语义):清掉 unified-state 三件套登录态。
// IDE 重启后回到未登录态,由用户自行重新登录或切回远程。
func RestorePath(dbPath string) error {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	defer db.Close()
	for _, key := range []string{keyOAuthToken, keyUserStatus, keyEnterprisePreferences} {
		if _, err := db.Exec(`DELETE FROM ItemTable WHERE key = ?`, key); err != nil {
			return fmt.Errorf("清理 %s 失败: %w", key, err)
		}
	}
	return nil
}

func injectUnifiedOAuthToken(db *sql.DB, t Token) error {
	current := readItem(db, keyOAuthToken)
	var topic []byte
	if current != "" {
		if decoded, err := base64.StdEncoding.DecodeString(current); err == nil {
			if cleaned, ok := removeUnifiedTopicEntry(decoded, sentinelOAuthTokenInfo); ok {
				topic = cleaned
			}
		}
	}
	oauthInfo := createOAuthInfoWithMetadata(t.AccessToken, t.RefreshToken, t.Expiry, t.IsGCPTos, t.IDToken, t.Email)
	topic = append(topic, createUnifiedTopicEntry(sentinelOAuthTokenInfo, oauthInfo)...)
	if _, err := db.Exec(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, keyOAuthToken, base64Std(topic)); err != nil {
		return fmt.Errorf("写入 OAuth Token 失败: %w", err)
	}
	return nil
}

func injectUserStatus(db *sql.DB, email string) error {
	payload := createMinimalUserStatusPayload(email)
	topic := createUnifiedTopicEntry(sentinelUserStatus, payload)
	if _, err := db.Exec(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, keyUserStatus, base64Std(topic)); err != nil {
		return fmt.Errorf("写入 UserStatus 失败: %w", err)
	}
	return nil
}

func injectEnterpriseProjectPreference(db *sql.DB, projectID string) error {
	payload := createStringValuePayload(projectID)
	topic := createUnifiedTopicEntry(sentinelEnterprise, payload)
	if _, err := db.Exec(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, keyEnterprisePreferences, base64Std(topic)); err != nil {
		return fmt.Errorf("写入 Enterprise Preference 失败: %w", err)
	}
	return nil
}

func clearEnterpriseProjectPreference(db *sql.DB) error {
	if _, err := db.Exec(`DELETE FROM ItemTable WHERE key = ?`, keyEnterprisePreferences); err != nil {
		return fmt.Errorf("清理 Enterprise Preference 失败: %w", err)
	}
	return nil
}

func readItem(db *sql.DB, key string) string {
	var v string
	if err := db.QueryRow(`SELECT value FROM ItemTable WHERE key = ?`, key).Scan(&v); err != nil {
		return ""
	}
	return v
}

func base64Std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func toLowerASCII(s string) string { return strings.ToLower(s) }

func hasSuffix(s, suffix string) bool { return strings.HasSuffix(s, suffix) }

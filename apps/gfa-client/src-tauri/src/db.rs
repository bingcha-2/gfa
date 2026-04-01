use rusqlite::{Connection, params};
use std::sync::Mutex;
use crate::models::{Account, AccountStatus, AntigravityToken, DeviceProfile};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("DB open error: {}", e))?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                recovery_email TEXT,
                totp_secret TEXT,
                status TEXT NOT NULL DEFAULT 'new',
                created_at TEXT NOT NULL,
                last_login_at TEXT,
                ag_access_token TEXT,
                ag_refresh_token TEXT,
                ag_expires_at INTEGER,
                ag_email TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ").map_err(|e| format!("Init tables error: {}", e))?;

        // 热迁移：新增设备指纹列（忽略已存在错误）
        let _ = conn.execute("ALTER TABLE accounts ADD COLUMN ag_device_profile TEXT", []);

        Ok(())
    }

    pub fn upsert_account(&self, email: &str, password: &str, recovery_email: Option<&str>, totp_secret: Option<&str>) -> Result<Account, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO accounts (id, email, password, recovery_email, totp_secret, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'new', ?6)
             ON CONFLICT(email) DO UPDATE SET
                password = excluded.password,
                recovery_email = excluded.recovery_email,
                totp_secret = excluded.totp_secret",
            params![id, email, password, recovery_email, totp_secret, now],
        ).map_err(|e| format!("Upsert error: {}", e))?;

        // 内联查询，复用同一个 conn，避免重复加锁导致死锁
        conn.query_row(
            "SELECT id, email, password, recovery_email, totp_secret, status, created_at, last_login_at,
                    ag_access_token, ag_refresh_token, ag_expires_at, ag_email, ag_device_profile
             FROM accounts WHERE email = ?1",
            params![email],
            |row| {
                let ag_token = match (row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?) {
                    (Some(at), Some(rt)) => Some(AntigravityToken {
                        access_token: at,
                        refresh_token: rt,
                        expires_at: row.get(10).unwrap_or(0),
                        email: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                    }),
                    _ => None,
                };
                let ag_device_profile = row.get::<_, Option<String>>(12)?
                    .and_then(|s| serde_json::from_str::<DeviceProfile>(&s).ok());
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    password: row.get(2)?,
                    recovery_email: row.get(3)?,
                    totp_secret: row.get(4)?,
                    status: parse_status(&row.get::<_, String>(5)?),
                    created_at: row.get(6)?,
                    last_login_at: row.get(7)?,
                    antigravity_token: ag_token,
                    ag_device_profile,
                })
            },
        ).map_err(|e| format!("Query error: {}", e))
    }

    pub fn get_account_by_email(&self, email: &str) -> Result<Account, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, email, password, recovery_email, totp_secret, status, created_at, last_login_at,
                    ag_access_token, ag_refresh_token, ag_expires_at, ag_email, ag_device_profile
             FROM accounts WHERE email = ?1",
            params![email],
            |row| {
                let ag_token = match (row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?) {
                    (Some(at), Some(rt)) => Some(AntigravityToken {
                        access_token: at,
                        refresh_token: rt,
                        expires_at: row.get(10).unwrap_or(0),
                        email: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                    }),
                    _ => None,
                };
                let ag_device_profile = row.get::<_, Option<String>>(12)?
                    .and_then(|s| serde_json::from_str::<DeviceProfile>(&s).ok());
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    password: row.get(2)?,
                    recovery_email: row.get(3)?,
                    totp_secret: row.get(4)?,
                    status: parse_status(&row.get::<_, String>(5)?),
                    created_at: row.get(6)?,
                    last_login_at: row.get(7)?,
                    antigravity_token: ag_token,
                    ag_device_profile,
                })
            },
        ).map_err(|e| format!("Query error: {}", e))
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, email, password, recovery_email, totp_secret, status, created_at, last_login_at,
                    ag_access_token, ag_refresh_token, ag_expires_at, ag_email, ag_device_profile
             FROM accounts ORDER BY created_at DESC"
        ).map_err(|e| format!("Prepare error: {}", e))?;

        let accounts = stmt.query_map([], |row| {
            let ag_token = match (row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?) {
                (Some(at), Some(rt)) => Some(AntigravityToken {
                    access_token: at,
                    refresh_token: rt,
                    expires_at: row.get(10).unwrap_or(0),
                    email: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                }),
                _ => None,
            };
            let ag_device_profile = row.get::<_, Option<String>>(12)?
                .and_then(|s| serde_json::from_str::<DeviceProfile>(&s).ok());
            Ok(Account {
                id: row.get(0)?,
                email: row.get(1)?,
                password: row.get(2)?,
                recovery_email: row.get(3)?,
                totp_secret: row.get(4)?,
                status: parse_status(&row.get::<_, String>(5)?),
                created_at: row.get(6)?,
                last_login_at: row.get(7)?,
                antigravity_token: ag_token,
                ag_device_profile,
            })
        }).map_err(|e| format!("Query error: {}", e))?;

        accounts.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Collect error: {}", e))
    }

    pub fn update_account_status(&self, email: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET status = ?1, last_login_at = ?2 WHERE email = ?3",
            params![status, chrono::Utc::now().to_rfc3339(), email],
        ).map_err(|e| format!("Update error: {}", e))?;
        Ok(())
    }

    pub fn update_antigravity_token(&self, email: &str, token: &AntigravityToken) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET ag_access_token = ?1, ag_refresh_token = ?2, ag_expires_at = ?3, ag_email = ?4 WHERE email = ?5",
            params![token.access_token, token.refresh_token, token.expires_at, token.email, email],
        ).map_err(|e| format!("Update token error: {}", e))?;
        Ok(())
    }

    /// 保存/更新账号绑定的设备指纹（JSON 序列化后存入 ag_device_profile 列）
    pub fn update_device_profile(&self, email: &str, profile: &DeviceProfile) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(profile).map_err(|e| format!("Serialize profile error: {}", e))?;
        conn.execute(
            "UPDATE accounts SET ag_device_profile = ?1 WHERE email = ?2",
            params![json, email],
        ).map_err(|e| format!("Update device profile error: {}", e))?;
        Ok(())
    }

    pub fn delete_account(&self, email: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM accounts WHERE email = ?1", params![email])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Setting query error: {}", e))
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        ).map_err(|e| format!("Setting update error: {}", e))?;
        Ok(())
    }
}

fn parse_status(s: &str) -> AccountStatus {
    match s {
        "active" => AccountStatus::Active,
        "login_failed" => AccountStatus::LoginFailed,
        "locked" => AccountStatus::Locked,
        "disabled" => AccountStatus::Disabled,
        _ => AccountStatus::New,
    }
}

use rusqlite::OptionalExtension;

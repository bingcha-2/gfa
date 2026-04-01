use serde::{Deserialize, Serialize};

/// 设备指纹信息（用于切号时绑定设备身份，防止频繁变更导致封号）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub machine_id: String,
    pub mac_machine_id: String,
    pub dev_device_id: String,
    pub sqm_id: String,
    pub service_machine_id: String,
}

/// Parsed credentials from "email----password----recoveryEmail----totpSecret" format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountCredentials {
    pub email: String,
    pub password: String,
    pub recovery_email: Option<String>,
    pub totp_secret: Option<String>,
}

impl AccountCredentials {
    /// Parse from "email----password----recoveryEmail----totpSecret" format
    /// Also accepts ---, ----, ——, ––, and mixed formats
    pub fn parse(line: &str) -> Result<Self, String> {
        // Split on 2+ consecutive ASCII hyphens, em dashes, or en dashes
        let parts: Vec<&str> = line.trim()
            .split("----")
            .flat_map(|s| s.split("---"))
            .flat_map(|s| s.split("——"))
            .flat_map(|s| s.split("––"))
            .collect();
        if parts.len() < 2 {
            return Err(format!("Invalid format: expected at least email----password, got {} parts", parts.len()));
        }
        Ok(Self {
            email: parts[0].trim().to_string(),
            password: parts[1].trim().to_string(),
            recovery_email: parts.get(2).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            totp_secret: parts.get(3).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        })
    }

    /// Parse multiple lines (batch import)
    pub fn parse_batch(text: &str) -> Vec<Result<Self, String>> {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(Self::parse)
            .collect()
    }
}

/// Account stored in local database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub password: String,
    pub recovery_email: Option<String>,
    pub totp_secret: Option<String>,
    pub status: AccountStatus,
    pub created_at: String,
    pub last_login_at: Option<String>,
    pub antigravity_token: Option<AntigravityToken>,
    /// 绑定的设备指纹（首次切号时生成，后续复用）
    pub ag_device_profile: Option<DeviceProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    New,
    Active,
    LoginFailed,
    Locked,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityToken {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub email: String,
}

/// GFA API types
#[derive(Debug, Serialize, Deserialize)]
pub struct RedeemRequest {
    pub code: String,
    pub email: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResponse {
    pub order_no: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatus {
    pub order_no: String,
    pub status: String,
    pub user_email: String,
    pub result_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}


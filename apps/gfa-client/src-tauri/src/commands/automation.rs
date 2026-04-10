use tauri::State;
use crate::db::Database;
use serde::{Deserialize, Serialize};

fn get_api_url(db: &Database) -> String {
    let url = db.get_setting("gfa_api_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| "http://localhost:3001".to_string());
    // Strip trailing /api or /api/ to avoid double prefix
    let url = url.trim_end_matches('/').to_string();
    let url = url.strip_suffix("/api").unwrap_or(&url).to_string();
    url
}

// ============================================================
// API response types
// ============================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct AutomationStartResponse {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub action: String,
    pub email: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AutomationStatusResponse {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "type")]
    pub task_type: Option<String>,
    pub status: String,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<String>,
    #[serde(rename = "lastErrorCode")]
    pub last_error_code: Option<String>,
    #[serde(rename = "lastErrorMessage")]
    pub last_error_message: Option<String>,
    pub result: Option<serde_json::Value>,
    pub logs: Option<Vec<AutomationLogEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AutomationLogEntry {
    pub level: String,
    pub message: String,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchOAuthResponse {
    pub total: usize,
    pub queued: usize,
    pub failed: usize,
    pub results: Vec<BatchOAuthResult>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchOAuthResult {
    pub email: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    pub error: Option<String>,
}

/// Server response from POST /api/phone-pool/sync
#[derive(Debug, Serialize, Deserialize)]
struct PhoneSyncStatus {
    #[serde(rename = "phoneNumber")]
    pub phone_number: String,
    pub status: String,
}

// ============================================================
// Commands — call GFA API for automation
// ============================================================

/// Start an automation task (accept-invite) via API.
/// Sends credentials from local SQLite to the server.
#[tauri::command]
pub async fn run_accept_invite(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "accept-invite", &db).await
}

/// Start Antigravity OAuth via API.
/// Returns the task ID; frontend polls for the token result.
#[tauri::command]
pub async fn start_antigravity_oauth(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "oauth", &db).await
}

/// Start phone verification for an account.
/// Attaches available phone numbers from local pool.
#[tauri::command]
pub async fn start_phone_verify(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "phone-verify", &db).await
}

/// Poll automation task status.
#[tauri::command]
pub async fn poll_automation_status(task_id: String, db: State<'_, Database>) -> Result<AutomationStatusResponse, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/automation/status/{}", api_url, urlencoding::encode(&task_id)))
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<AutomationStatusResponse>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

/// Batch OAuth via API.
#[tauri::command]
pub async fn batch_automation_oauth(emails: Vec<String>, db: State<'_, Database>) -> Result<BatchOAuthResponse, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    // Gather credentials for all accounts
    let mut accounts = Vec::new();
    for em in &emails {
        let account = db.get_account_by_email(em)?;
        accounts.push(serde_json::json!({
            "email": account.email,
            "password": account.password,
            "recoveryEmail": account.recovery_email,
            "totpSecret": account.totp_secret
        }));
    }

    let payload = serde_json::json!({ "accounts": accounts });

    let response = client
        .post(format!("{}/api/automation/batch-oauth", api_url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<BatchOAuthResponse>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

// ============================================================
// Internal helper
// ============================================================

async fn start_automation(email: &str, action: &str, db: &Database) -> Result<AutomationStartResponse, String> {
    let api_url = get_api_url(db);
    let account = db.get_account_by_email(email)?;
    let client = reqwest::Client::new();

    let mut payload = serde_json::json!({
        "action": action,
        "email": account.email,
        "password": account.password,
        "recoveryEmail": account.recovery_email,
        "totpSecret": account.totp_secret
    });

    // Attach local phone numbers for accept-invite and phone-verify actions
    if action == "accept-invite" || action == "phone-verify" {
        if let Ok(phones) = db.get_available_phones() {
            if !phones.is_empty() {
                let phone_list: Vec<serde_json::Value> = phones.iter().map(|p| {
                    serde_json::json!({
                        "phoneNumber": p.phone_number,
                        "countryCode": p.country_code,
                        "smsUrl": p.sms_url
                    })
                }).collect();
                payload["phones"] = serde_json::Value::Array(phone_list.clone());

                // Sync to server at most once every 5 minutes to avoid excessive requests
                use std::sync::atomic::{AtomicI64, Ordering};
                static LAST_SYNC: AtomicI64 = AtomicI64::new(0);
                const SYNC_COOLDOWN_SECS: i64 = 300; // 5 minutes

                let now = chrono::Utc::now().timestamp();
                let last = LAST_SYNC.load(Ordering::Relaxed);

                if now - last > SYNC_COOLDOWN_SECS {
                    let sync_url = format!("{}/api/phone-pool/sync", api_url);
                    let sync_payload = serde_json::json!({
                        "phones": phone_list,
                        "source": "gfa-client"
                    });
                    if let Ok(sync_resp) = client
                        .post(&sync_url)
                        .json(&sync_payload)
                        .send()
                        .await
                    {
                        // Only update cooldown timestamp after a successful request
                        LAST_SYNC.store(now, Ordering::Relaxed);

                        // Server returns [{phoneNumber, status}] — update local disabled status
                        if let Ok(server_statuses) = sync_resp.json::<Vec<PhoneSyncStatus>>().await {
                            for ps in &server_statuses {
                                if ps.status == "disabled" {
                                    let _ = db.disable_phone_by_number(&ps.phone_number);
                                }
                            }
                            // Remove disabled phones from payload
                            let disabled_set: std::collections::HashSet<&str> = server_statuses
                                .iter()
                                .filter(|s| s.status == "disabled")
                                .map(|s| s.phone_number.as_str())
                                .collect();
                            if !disabled_set.is_empty() {
                                let filtered: Vec<serde_json::Value> = phone_list
                                    .into_iter()
                                    .filter(|p| {
                                        let num = p["phoneNumber"].as_str().unwrap_or("");
                                        !disabled_set.contains(num)
                                    })
                                    .collect();
                                payload["phones"] = serde_json::Value::Array(filtered);
                            }
                        }
                    }
                }
            }
        }
    }

    let response = client
        .post(format!("{}/api/automation/start", api_url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<AutomationStartResponse>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}


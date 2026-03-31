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

// ============================================================
// Commands — call GFA API for automation
// ============================================================

/// Start an automation task (accept-invite or test-login) via API.
/// Sends credentials from local SQLite to the server.
#[tauri::command]
pub async fn run_accept_invite(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "accept-invite", &db).await
}

#[tauri::command]
pub async fn run_test_login(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "test-login", &db).await
}

/// Start Antigravity OAuth via API.
/// Returns the task ID; frontend polls for the token result.
#[tauri::command]
pub async fn start_antigravity_oauth(email: String, db: State<'_, Database>) -> Result<AutomationStartResponse, String> {
    start_automation(&email, "oauth", &db).await
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

    let payload = serde_json::json!({
        "action": action,
        "email": account.email,
        "password": account.password,
        "recoveryEmail": account.recovery_email,
        "totpSecret": account.totp_secret
    });

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

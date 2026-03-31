//! Antigravity 数据库操作 + 设备指纹 + 一键切号
//! 移植自 cockpit-tools 的 db.rs / device.rs / fingerprint.rs

use base64::{engine::general_purpose, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{Connection, Error as SqliteError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::models::DeviceProfile;
use crate::utils::protobuf;

// ─── 常量 ─────────────────────────────────────────────

const CLIENT_ID: &str = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET: &str = "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";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

// ─── DeviceProfile（定义已移到 models/mod.rs）─────────

// ─── 路径定位 ──────────────────────────────────────────

/// Antigravity 的 state.vscdb 路径
pub fn get_db_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        let path = home.join("Library/Application Support/Antigravity/User/globalStorage/state.vscdb");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("数据库文件不存在: {:?}", path));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "无法获取 APPDATA".to_string())?;
        let path = PathBuf::from(appdata).join("Antigravity\\User\\globalStorage\\state.vscdb");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("数据库文件不存在: {:?}", path));
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        let path = home.join(".config/Antigravity/User/globalStorage/state.vscdb");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("数据库文件不存在: {:?}", path));
    }
}

/// Antigravity 的 storage.json 路径
pub fn get_storage_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        let path = home.join("Library/Application Support/Antigravity/User/globalStorage/storage.json");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("storage.json 不存在: {:?}", path));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "无法获取 APPDATA".to_string())?;
        let path = PathBuf::from(appdata).join("Antigravity\\User\\globalStorage\\storage.json");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("storage.json 不存在: {:?}", path));
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        let path = home.join(".config/Antigravity/User/globalStorage/storage.json");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("storage.json 不存在: {:?}", path));
    }
}

/// machineid 文件路径
fn get_machine_id_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        return Ok(home.join("Library/Application Support/Antigravity/machineid"));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "无法获取 APPDATA".to_string())?;
        return Ok(PathBuf::from(appdata).join("Antigravity\\machineid"));
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir().ok_or("无法获取 Home 目录")?;
        return Ok(home.join(".config/Antigravity/machineid"));
    }

    #[allow(unreachable_code)]
    Err("无法确定 machineid 路径".to_string())
}

// ─── Token 注入 ────────────────────────────────────────

/// 注入 Token 到 Antigravity 数据库（新旧两种格式）
pub fn inject_token(access_token: &str, refresh_token: &str, expiry: i64) -> Result<String, String> {
    let db_path = get_db_path()?;
    inject_token_to_path(&db_path, access_token, refresh_token, expiry)
}

fn inject_token_to_path(db_path: &Path, access_token: &str, refresh_token: &str, expiry: i64) -> Result<String, String> {
    // 新格式
    inject_unified_oauth_token(db_path, access_token, refresh_token, expiry)?;

    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    // 旧格式
    let current_data: Option<String> = match conn.query_row(
        "SELECT value FROM ItemTable WHERE key = ?",
        ["jetskiStateSync.agentManagerInitState"],
        |row| row.get(0),
    ) {
        Ok(value) => Some(value),
        Err(SqliteError::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("读取数据失败: {}", e)),
    };

    if let Some(current_data) = current_data {
        let blob = general_purpose::STANDARD
            .decode(&current_data)
            .map_err(|e| format!("Base64 解码失败: {}", e))?;
        let clean_data = protobuf::remove_field(&blob, 6)?;
        let new_field = protobuf::create_oauth_field(access_token, refresh_token, expiry);
        let final_data = [clean_data, new_field].concat();
        let final_b64 = general_purpose::STANDARD.encode(&final_data);
        conn.execute(
            "UPDATE ItemTable SET value = ? WHERE key = ?",
            [&final_b64, "jetskiStateSync.agentManagerInitState"],
        ).map_err(|e| format!("写入数据失败: {}", e))?;
    }

    // Onboarding 标记
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["antigravityOnboarding", "true"],
    ).map_err(|e| format!("写入 Onboarding 标记失败: {}", e))?;

    Ok(format!("Token 注入成功！数据库: {:?}", db_path))
}

fn inject_unified_oauth_token(db_path: &Path, access_token: &str, refresh_token: &str, expiry: i64) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let oauth_info = protobuf::create_oauth_info(access_token, refresh_token, expiry);
    let oauth_info_b64 = general_purpose::STANDARD.encode(&oauth_info);

    let inner2 = protobuf::encode_string_field(1, &oauth_info_b64);
    let inner1 = protobuf::encode_string_field(1, "oauthTokenInfoSentinelKey");
    let inner = [inner1, protobuf::encode_len_delim_field(2, &inner2)].concat();
    let outer = protobuf::encode_len_delim_field(1, &inner);
    let outer_b64 = general_purpose::STANDARD.encode(&outer);

    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["antigravityUnifiedStateSync.oauthToken", &outer_b64],
    ).map_err(|e| format!("写入新格式失败: {}", e))?;

    Ok(())
}

/// 写入 serviceMachineId 到 state.vscdb
fn write_service_machine_id_to_db(service_machine_id: &str) -> Result<(), String> {
    let db_path = get_db_path()?;
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["storage.serviceMachineId", service_machine_id],
    ).map_err(|e| format!("写入 serviceMachineId 失败: {}", e))?;
    Ok(())
}

// ─── 设备指纹 ──────────────────────────────────────────

/// 生成新的设备指纹
pub fn generate_device_profile() -> DeviceProfile {
    DeviceProfile {
        machine_id: format!("auth0|user_{}", random_hex(32)),
        mac_machine_id: new_standard_machine_id(),
        dev_device_id: Uuid::new_v4().to_string(),
        sqm_id: format!("{{{}}}", Uuid::new_v4().to_string().to_uppercase()),
        service_machine_id: Uuid::new_v4().to_string(),
    }
}

/// 将设备指纹写入 storage.json
pub fn write_device_profile(profile: &DeviceProfile) -> Result<(), String> {
    let storage_path = get_storage_path()?;
    write_device_profile_to_path(&storage_path, profile)
}

fn write_device_profile_to_path(storage_path: &Path, profile: &DeviceProfile) -> Result<(), String> {
    let content = fs::read_to_string(storage_path)
        .map_err(|e| format!("读取 storage.json 失败: {}", e))?;
    let mut json: Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 storage.json 失败: {}", e))?;

    // 确保 telemetry 对象存在
    if !json.get("telemetry").map_or(false, |v| v.is_object()) {
        if json.as_object_mut().is_some() {
            json["telemetry"] = serde_json::json!({});
        }
    }

    // 写入嵌套格式
    if let Some(telemetry) = json.get_mut("telemetry").and_then(|v| v.as_object_mut()) {
        telemetry.insert("machineId".to_string(), Value::String(profile.machine_id.clone()));
        telemetry.insert("macMachineId".to_string(), Value::String(profile.mac_machine_id.clone()));
        telemetry.insert("devDeviceId".to_string(), Value::String(profile.dev_device_id.clone()));
        telemetry.insert("sqmId".to_string(), Value::String(profile.sqm_id.clone()));
    }

    // 写入扁平格式（兼容旧版）
    if let Some(map) = json.as_object_mut() {
        map.insert("telemetry.machineId".to_string(), Value::String(profile.machine_id.clone()));
        map.insert("telemetry.macMachineId".to_string(), Value::String(profile.mac_machine_id.clone()));
        map.insert("telemetry.devDeviceId".to_string(), Value::String(profile.dev_device_id.clone()));
        map.insert("telemetry.sqmId".to_string(), Value::String(profile.sqm_id.clone()));
    }

    let updated = serde_json::to_string_pretty(&json).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(storage_path, updated).map_err(|e| format!("写入失败: {}", e))?;

    // 同步 machineid 文件
    write_machine_id_file(&profile.service_machine_id)?;

    // 同步 state.vscdb
    let _ = write_service_machine_id_to_db(&profile.service_machine_id);

    Ok(())
}

fn write_machine_id_file(service_id: &str) -> Result<(), String> {
    let path = get_machine_id_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 machineid 目录失败: {}", e))?;
    }
    fs::write(&path, service_id).map_err(|e| format!("写入 machineid 失败: {}", e))?;
    Ok(())
}

fn random_hex(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect::<String>()
        .to_lowercase()
}

fn new_standard_machine_id() -> String {
    let mut rng = rand::thread_rng();
    let mut id = String::with_capacity(36);
    for ch in "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".chars() {
        if ch == '-' || ch == '4' {
            id.push(ch);
        } else if ch == 'x' {
            id.push_str(&format!("{:x}", rng.gen_range(0..16)));
        } else if ch == 'y' {
            id.push_str(&format!("{:x}", rng.gen_range(8..12)));
        }
    }
    id
}

// ─── Token 刷新 ────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    expires_in: i64,
    #[allow(dead_code)]
    token_type: Option<String>,
}

/// 使用 refresh_token 刷新 access_token
pub async fn refresh_access_token(refresh_token: &str) -> Result<(String, i64), String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];

    let response = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("刷新请求失败: {}", e))?;

    if response.status().is_success() {
        let data = response.json::<RefreshResponse>().await
            .map_err(|e| format!("刷新数据解析失败: {}", e))?;
        let expires_at = chrono::Utc::now().timestamp() + data.expires_in;
        Ok((data.access_token, expires_at))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("刷新失败: {}", text))
    }
}

// ─── 进程管理 ──────────────────────────────────────────

/// 关闭 Antigravity 进程（精确匹配，不会误杀 GFA 客户端）
fn close_antigravity() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 用 pgrep 精确匹配 Antigravity.app 的可执行文件路径
        let pids = match std::process::Command::new("pgrep")
            .args(["-f", "Antigravity.app/Contents/MacOS/"])
            .output()
        {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                    .collect::<Vec<_>>()
            }
            _ => Vec::new(),
        };

        if pids.is_empty() {
            return Ok(()); // 没在运行
        }

        // 先发 SIGTERM (graceful)
        for pid in &pids {
            let _ = std::process::Command::new("kill")
                .args(["-15", &pid.to_string()])
                .output();
        }

        // 等待最多 5 秒
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let still_running = pids.iter().any(|pid| {
                std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            });
            if !still_running {
                return Ok(());
            }
        }

        // 强制杀
        for pid in &pids {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    #[cfg(target_os = "windows")]
    {
        // 先优雅关闭（不带 /F）
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "Antigravity.exe"])
            .output();
        std::thread::sleep(std::time::Duration::from_secs(3));

        // 检查是否还在运行，强制杀
        let check = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Antigravity.exe", "/NH"])
            .output();
        if let Ok(output) = check {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("Antigravity.exe") {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "Antigravity.exe", "/T"])
                    .output();
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "antigravity"])
            .output();
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    Ok(())
}

/// 启动 Antigravity
fn start_antigravity() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Antigravity"])
            .spawn()
            .map_err(|e| format!("启动 Antigravity 失败: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        let paths = [
            format!("{}\\Programs\\Antigravity\\Antigravity.exe", std::env::var("LOCALAPPDATA").unwrap_or_default()),
            format!("{}\\Antigravity\\Antigravity.exe", std::env::var("PROGRAMFILES").unwrap_or_default()),
        ];
        for path in &paths {
            if Path::new(path).exists() {
                std::process::Command::new(path)
                    .spawn()
                    .map_err(|e| format!("启动 Antigravity 失败: {}", e))?;
                return Ok(());
            }
        }
        return Err("未找到 Antigravity 可执行文件".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("antigravity")
            .spawn()
            .map_err(|e| format!("启动 Antigravity 失败: {}", e))?;
    }
    Ok(())
}

// ─── Tauri Commands ────────────────────────────────────

/// 一键切号：刷新token → 关闭Antigravity → 注入token → 切指纹 → 重启
#[tauri::command]
pub async fn switch_antigravity_account(
    email: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<String, String> {
    let account = db.get_account_by_email(&email)?;
    let token = account.antigravity_token.ok_or("该账号没有 Antigravity Token，请先授权")?;

    // 1. 刷新 token（如果快过期）
    let now = chrono::Utc::now().timestamp();
    let (access_token, expires_at) = if token.expires_at < now + 300 {
        let (new_at, new_exp) = refresh_access_token(&token.refresh_token).await?;
        // 保存刷新后的 token
        let updated_token = crate::models::AntigravityToken {
            access_token: new_at.clone(),
            refresh_token: token.refresh_token.clone(),
            expires_at: new_exp,
            email: token.email.clone(),
        };
        db.update_antigravity_token(&email, &updated_token)?;
        (new_at, new_exp)
    } else {
        (token.access_token.clone(), token.expires_at)
    };

    // 2. 关闭 Antigravity
    close_antigravity()?;

    // 3. 注入 Token
    inject_token(&access_token, &token.refresh_token, expires_at)?;

    // 4. 复用或生成设备指纹（防封号核心：同一账号始终使用同一组指纹）
    let profile = if let Some(existing) = account.ag_device_profile {
        eprintln!("[切号] 复用已绑定的设备指纹: machineId={}", existing.machine_id);
        existing
    } else {
        let new_profile = generate_device_profile();
        eprintln!("[切号] 首次切号，生成并保存设备指纹: machineId={}", new_profile.machine_id);
        // 持久化到数据库
        db.update_device_profile(&email, &new_profile)?;
        new_profile
    };
    match write_device_profile(&profile) {
        Ok(()) => {}
        Err(e) => {
            // 指纹写入失败不阻断流程（可能 storage.json 不存在）
            eprintln!("设备指纹写入失败（不影响切号）: {}", e);
        }
    }

    // 5. 启动 Antigravity
    match start_antigravity() {
        Ok(()) => {}
        Err(e) => {
            return Ok(format!("Token 已注入，但 Antigravity 启动失败: {}。请手动启动。", e));
        }
    }

    Ok(format!("切号成功！已切换到 {}", email))
}

/// 保存 Antigravity Token（OAuth 完成后从 server 拿到 token，直接保存到本地 SQLite）
#[tauri::command]
pub async fn save_antigravity_token(
    email: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<crate::models::AntigravityToken, String> {
    let token = crate::models::AntigravityToken {
        access_token,
        refresh_token,
        expires_at,
        email: email.clone(),
    };
    db.update_antigravity_token(&email, &token)?;
    Ok(token)
}

/// 刷新 Antigravity Token
#[tauri::command]
pub async fn refresh_antigravity_token(
    email: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<crate::models::AntigravityToken, String> {
    let account = db.get_account_by_email(&email)?;
    let token = account.antigravity_token.ok_or("该账号没有 Antigravity Token")?;

    let (new_access_token, new_expires_at) = refresh_access_token(&token.refresh_token).await?;

    let updated_token = crate::models::AntigravityToken {
        access_token: new_access_token,
        refresh_token: token.refresh_token,
        expires_at: new_expires_at,
        email: token.email,
    };

    db.update_antigravity_token(&email, &updated_token)?;
    Ok(updated_token)
}

// ─── 额度查询 ──────────────────────────────────────────

const CLOUD_CODE_BASE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_PATH: &str = "v1internal:loadCodeAssist";
const FETCH_AVAILABLE_MODELS_PATH: &str = "v1internal:fetchAvailableModels";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelQuota {
    pub name: String,
    pub display_name: Option<String>,
    pub percentage: i32,      // 剩余百分比 0-100
    pub reset_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaInfo {
    pub subscription_tier: Option<String>,  // FREE / PRO / ULTRA
    pub models: Vec<ModelQuota>,
    pub is_forbidden: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadProjectResponse {
    #[serde(rename = "cloudaicompanionProject")]
    project: Option<serde_json::Value>,
    #[serde(rename = "currentTier")]
    current_tier: Option<TierInfo>,
    #[serde(rename = "paidTier")]
    paid_tier: Option<TierInfo>,
}

#[derive(Debug, Deserialize)]
struct TierInfo {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FetchModelsResponse {
    models: Option<std::collections::HashMap<String, ModelDetail>>,
}

#[derive(Debug, Deserialize)]
struct ModelDetail {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "quotaInfo")]
    quota_info: Option<ModelQuotaInfo>,
}

#[derive(Debug, Deserialize)]
struct ModelQuotaInfo {
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
}

fn extract_project_id(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if !text.is_empty() { return Some(text.to_string()); }
    }
    if let Some(obj) = value.as_object() {
        if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() { return Some(id.to_string()); }
        }
    }
    None
}

async fn fetch_project_and_tier(access_token: &str) -> Result<(Option<String>, Option<String>), String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "metadata": {
            "ide_type": "ANTIGRAVITY",
            "ide_version": "1.20.5",
            "ide_name": "antigravity"
        }
    });

    let response = client
        .post(format!("{}/{}", CLOUD_CODE_BASE_URL, LOAD_CODE_ASSIST_PATH))
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("User-Agent", "antigravity")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("loadCodeAssist 请求失败: {}", e))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Token 无效 (401)".to_string());
    }
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("无权限 (403)".to_string());
    }
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("loadCodeAssist 失败: {}", text));
    }

    let data = response.json::<LoadProjectResponse>().await
        .map_err(|e| format!("loadCodeAssist 解析失败: {}", e))?;

    let tier = data.paid_tier.and_then(|t| t.id)
        .or_else(|| data.current_tier.and_then(|t| t.id));
    let project_id = data.project.as_ref().and_then(extract_project_id);

    Ok((project_id, tier))
}

async fn fetch_model_quotas(access_token: &str, project_id: Option<&str>) -> Result<Vec<ModelQuota>, String> {
    let client = reqwest::Client::new();
    let payload = match project_id {
        Some(pid) => serde_json::json!({ "project": pid }),
        None => serde_json::json!({}),
    };

    let response = client
        .post(format!("{}/{}", CLOUD_CODE_BASE_URL, FETCH_AVAILABLE_MODELS_PATH))
        .bearer_auth(access_token)
        .header("User-Agent", "antigravity")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("fetchAvailableModels 请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("fetchAvailableModels 失败: {} - {}", status, text));
    }

    let data = response.json::<FetchModelsResponse>().await
        .map_err(|e| format!("fetchAvailableModels 解析失败: {}", e))?;

    let mut models = Vec::new();
    if let Some(model_map) = data.models {
        for (name, detail) in model_map {
            if let Some(qi) = detail.quota_info {
                let percentage = qi.remaining_fraction
                    .map(|f| (f * 100.0) as i32)
                    .unwrap_or(0);
                models.push(ModelQuota {
                    name,
                    display_name: detail.display_name,
                    percentage,
                    reset_time: qi.reset_time.unwrap_or_default(),
                });
            }
        }
    }

    // 按模型名排序
    models.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(models)
}

/// 查询 Antigravity 账号额度
#[tauri::command]
pub async fn fetch_antigravity_quota(
    email: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<QuotaInfo, String> {
    let account = db.get_account_by_email(&email)?;
    let token = account.antigravity_token.ok_or("该账号没有 Antigravity Token，请先授权")?;

    // 先刷新 token
    let now = chrono::Utc::now().timestamp();
    let access_token = if token.expires_at < now + 300 {
        let (new_at, new_exp) = refresh_access_token(&token.refresh_token).await?;
        let updated_token = crate::models::AntigravityToken {
            access_token: new_at.clone(),
            refresh_token: token.refresh_token.clone(),
            expires_at: new_exp,
            email: token.email.clone(),
        };
        db.update_antigravity_token(&email, &updated_token)?;
        new_at
    } else {
        token.access_token.clone()
    };

    // 1. 获取 project_id 和订阅等级
    let (project_id, subscription_tier) = match fetch_project_and_tier(&access_token).await {
        Ok(result) => result,
        Err(e) => {
            return Ok(QuotaInfo {
                subscription_tier: None,
                models: vec![],
                is_forbidden: e.contains("403"),
                error: Some(e),
            });
        }
    };

    // 2. 获取模型额度
    let models = match fetch_model_quotas(&access_token, project_id.as_deref()).await {
        Ok(m) => m,
        Err(e) => {
            return Ok(QuotaInfo {
                subscription_tier,
                models: vec![],
                is_forbidden: e.contains("403"),
                error: Some(e),
            });
        }
    };

    Ok(QuotaInfo {
        subscription_tier,
        models,
        is_forbidden: false,
        error: None,
    })
}


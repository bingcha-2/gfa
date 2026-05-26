use tauri::State;
use crate::models::{RedeemRequest, RedeemResponse, OrderStatus};
use crate::db::Database;

fn get_api_url(db: &Database) -> String {
    db.get_setting("gfa_api_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| "http://localhost:3000".to_string())
}

#[tauri::command]
pub async fn redeem_code(code: String, email: String, db: State<'_, Database>) -> Result<RedeemResponse, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let req = RedeemRequest { code, email };
    let response = client
        .post(format!("{}/api/public/redeem", api_url))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<RedeemResponse>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

#[tauri::command]
pub async fn get_order_status(code: String, db: State<'_, Database>) -> Result<OrderStatus, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/public/orders/by-code/{}", api_url, urlencoding::encode(&code)))
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<OrderStatus>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

#[tauri::command]
pub async fn list_orders(email: Option<String>, db: State<'_, Database>) -> Result<Vec<OrderStatus>, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let mut request = client.get(format!("{}/api/orders", api_url));
    if let Some(email) = email {
        request = request.query(&[("email", email)]);
    }

    let response = request.send().await.map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        response.json::<Vec<OrderStatus>>().await.map_err(|e| format!("Parse error: {}", e))
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

#[tauri::command]
pub async fn swap_account(code: String, original_email: String, new_email: String, db: State<'_, Database>) -> Result<String, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let payload = serde_json::json!({
        "swapCode": code,
        "originalEmail": original_email,
        "newEmail": new_email
    });

    let response = client
        .post(format!("{}/api/public/swap-by-email", api_url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        // Return the full JSON response (contains orderNo, taskId, status)
        let body = response.text().await.unwrap_or_default();
        Ok(body)
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

/// Poll swap task status by orderNo
#[tauri::command]
pub async fn poll_swap_status(order_no: String, db: State<'_, Database>) -> Result<String, String> {
    let api_url = get_api_url(&db);
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/public/swap-status/{}", api_url, urlencoding::encode(&order_no)))
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        Ok(body)
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error: {}", text))
    }
}

#[tauri::command]
pub async fn update_gfa_api_url(url: String, db: State<'_, Database>) -> Result<(), String> {
    db.set_setting("gfa_api_url", &url)
}

#[tauri::command]
pub async fn get_gfa_api_url(db: State<'_, Database>) -> Result<String, String> {
    Ok(get_api_url(&db))
}

#[tauri::command]
pub async fn get_setting(key: String, db: State<'_, Database>) -> Result<String, String> {
    Ok(db.get_setting(&key)?.unwrap_or_default())
}

#[tauri::command]
pub async fn set_setting(key: String, value: String, db: State<'_, Database>) -> Result<(), String> {
    db.set_setting(&key, &value)
}

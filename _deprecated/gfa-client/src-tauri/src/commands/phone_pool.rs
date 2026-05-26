use tauri::State;
use crate::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct PhoneEntry {
    pub id: String,
    pub phone_number: String,
    pub country_code: String,
    pub sms_url: String,
    pub status: String,
    pub used_count: i64,
    pub last_used_at: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

/// Add a single phone number to the local pool
#[tauri::command]
pub async fn add_phone(
    phone_number: String,
    country_code: Option<String>,
    sms_url: String,
    notes: Option<String>,
    db: State<'_, Database>,
) -> Result<PhoneEntry, String> {
    db.add_phone(
        &phone_number,
        country_code.as_deref().unwrap_or("+1"),
        &sms_url,
        notes.as_deref(),
    )
}

/// Bulk import phones from text (format: phoneNumber|smsUrl per line)
#[tauri::command]
pub async fn import_phones(text: String, db: State<'_, Database>) -> Result<Vec<PhoneEntry>, String> {
    let mut results = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('|').map(|s| s.trim()).collect();
        match parts.len() {
            2 => {
                // phoneNumber|smsUrl
                match db.add_phone(parts[0], "+1", parts[1], None) {
                    Ok(entry) => results.push(entry),
                    Err(e) => {
                        eprintln!("Failed to import {}: {}", parts[0], e);
                    }
                }
            }
            3 => {
                // countryCode|phoneNumber|smsUrl
                match db.add_phone(parts[1], parts[0], parts[2], None) {
                    Ok(entry) => results.push(entry),
                    Err(e) => {
                        eprintln!("Failed to import {}: {}", parts[1], e);
                    }
                }
            }
            _ => {
                eprintln!("Invalid line format: {}", line);
            }
        }
    }
    Ok(results)
}

/// List all phones in the local pool
#[tauri::command]
pub async fn list_phones(db: State<'_, Database>) -> Result<Vec<PhoneEntry>, String> {
    db.list_phones()
}

/// Delete a phone by id
#[tauri::command]
pub async fn delete_phone(id: String, db: State<'_, Database>) -> Result<(), String> {
    db.delete_phone(&id)
}

/// Update phone status (available/disabled)
#[tauri::command]
pub async fn update_phone_status(
    id: String,
    status: String,
    db: State<'_, Database>,
) -> Result<(), String> {
    db.update_phone_status(&id, &status)
}

/// Increment used_count for a phone by phone_number
#[tauri::command]
pub async fn increment_phone_used(
    phone_number: String,
    db: State<'_, Database>,
) -> Result<(), String> {
    db.increment_phone_used(&phone_number)
}

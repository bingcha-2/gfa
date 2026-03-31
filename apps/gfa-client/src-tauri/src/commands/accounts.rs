use tauri::State;
use crate::db::Database;
use crate::models::{Account, AccountCredentials};

#[tauri::command]
pub fn import_accounts(text: String, db: State<'_, Database>) -> Result<Vec<Account>, String> {
    let results = AccountCredentials::parse_batch(&text);
    let mut accounts = Vec::new();
    let mut errors = Vec::new();

    for result in results {
        match result {
            Ok(creds) => {
                match db.upsert_account(
                    &creds.email,
                    &creds.password,
                    creds.recovery_email.as_deref(),
                    creds.totp_secret.as_deref(),
                ) {
                    Ok(account) => accounts.push(account),
                    Err(e) => errors.push(format!("{}: {}", creds.email, e)),
                }
            }
            Err(e) => errors.push(e),
        }
    }

    if !errors.is_empty() && accounts.is_empty() {
        return Err(errors.join("\n"));
    }

    Ok(accounts)
}

#[tauri::command]
pub fn list_accounts(db: State<'_, Database>) -> Result<Vec<Account>, String> {
    db.list_accounts()
}

#[tauri::command]
pub fn delete_account(email: String, db: State<'_, Database>) -> Result<(), String> {
    db.delete_account(&email)
}

#[tauri::command]
pub fn get_account(email: String, db: State<'_, Database>) -> Result<Account, String> {
    db.get_account_by_email(&email)
}

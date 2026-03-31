use tauri::Manager;

mod commands;
mod db;
mod models;
mod utils;
mod antigravity_db;

use db::Database;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Initialize database
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data directory");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
            let db_path = app_data_dir.join("gfa-client.db");
            let db = Database::new(&db_path.to_string_lossy())
                .expect("Failed to initialize database");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Account commands
            commands::accounts::import_accounts,
            commands::accounts::list_accounts,
            commands::accounts::delete_account,
            commands::accounts::get_account,
            // Automation commands (calls GFA API → Worker)
            commands::automation::run_accept_invite,
            commands::automation::run_test_login,
            commands::automation::start_antigravity_oauth,
            commands::automation::poll_automation_status,
            commands::automation::batch_automation_oauth,
            // GFA API commands
            commands::gfa_api::redeem_code,
            commands::gfa_api::get_order_status,
            commands::gfa_api::list_orders,
            commands::gfa_api::swap_account,
            commands::gfa_api::poll_swap_status,
            commands::gfa_api::update_gfa_api_url,
            commands::gfa_api::get_gfa_api_url,
            commands::gfa_api::get_setting,
            commands::gfa_api::set_setting,
            // Antigravity local commands (switch account stays local)
            antigravity_db::switch_antigravity_account,
            antigravity_db::save_antigravity_token,
            antigravity_db::refresh_antigravity_token,
            antigravity_db::fetch_antigravity_quota,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


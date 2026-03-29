mod config;
mod docker;
mod bridge;
mod oauth;
mod tray;

use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
fn get_status() -> serde_json::Value {
    serde_json::json!({
        "docker": docker::is_available(),
        "bridge": bridge::is_running(),
    })
}

async fn run_setup(app: AppHandle) {
    // Step 0: Load config (local file > router API > defaults)
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Loading config...",
        "percent": 5
    }));
    let cfg = config::load().await;

    // Step 1: Check Docker
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Checking Docker...",
        "percent": 10
    }));

    if !docker::is_available() {
        // Step 2: Install Docker
        if let Err(e) = docker::install(&app).await {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
            return;
        }
    }

    // Step 3: Run bridge container
    if !bridge::is_running() {
        if let Err(e) = bridge::run(&app, &cfg).await {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
            return;
        }

        // Step 4: Wait for health
        if let Err(e) = bridge::wait_for_health(&app, 30).await {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
            return;
        }
    }

    // Step 5: Open browser
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Opening browser...",
        "percent": 90
    }));
    bridge::open_in_browser();

    // Step 6: Done — hide window, start OAuth listeners
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Done!",
        "percent": 100
    }));

    // Hide the setup window after a short delay
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // Start OAuth port listeners from config.
    // Ports already bound by the bridge container are silently skipped.
    oauth::start_listeners(&cfg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_status])
        .setup(|app| {
            // Set up system tray
            if let Err(e) = tray::setup(app.handle()) {
                eprintln!("[Tray] Failed to set up system tray: {e}");
            }

            // Run the setup flow in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_setup(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

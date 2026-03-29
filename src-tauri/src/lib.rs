mod config;
mod docker;
mod bridge;
mod oauth;
mod tray;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
fn get_status() -> serde_json::Value {
    serde_json::json!({
        "docker": docker::is_available(),
    })
}

/// Startup: install Docker if needed, then sit in tray.
/// No bridge provisioning — that happens via deep link from the website.
async fn run_setup(app: AppHandle) {
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Checking Docker...",
        "percent": 20
    }));

    if !docker::is_available() {
        let _ = app.emit("setup-progress", serde_json::json!({
            "step": "Installing Docker...",
            "percent": 30
        }));
        if let Err(e) = docker::install(&app).await {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
            return;
        }
    }

    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Ready",
        "percent": 100
    }));

    // Hide setup window after a short delay
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Handle deep link: xaiworkspace://provision?env=dev|test|prod
/// Called when user clicks "Add System" on the website.
async fn handle_provision(app: AppHandle, env: String) {
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Provisioning bridge...",
        "percent": 10
    }));

    // Show the setup window
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    // Load config for the requested environment
    let cfg = match env.as_str() {
        "dev" => config::load_env("dev").await,
        "test" => config::load_env("test").await,
        _ => config::load_env("prod").await,
    };

    // Ensure Docker is available
    if !docker::is_available() {
        let _ = app.emit("setup-progress", serde_json::json!({
            "step": "Installing Docker...",
            "percent": 20
        }));
        if let Err(e) = docker::install(&app).await {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
            return;
        }
    }

    // Create a new bridge
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Creating bridge...",
        "percent": 50
    }));

    match bridge::create_new_bridge(&cfg).await {
        Ok(pairing_url) => {
            let _ = app.emit("setup-progress", serde_json::json!({
                "step": "Opening browser...",
                "percent": 90
            }));
            let _ = open::that(&pairing_url);

            let _ = app.emit("setup-progress", serde_json::json!({
                "step": "Done!",
                "percent": 100
            }));
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        Err(e) => {
            let _ = app.emit("setup-error", serde_json::json!({ "error": e }));
        }
    }

    // Start OAuth listeners for the provisioned environment
    let oauth_mgr = Arc::new(oauth::OAuthManager::new(cfg.router_url.clone()));
    oauth_mgr.start_all(&cfg).await;
}

/// Parse deep link URL and extract env parameter.
/// Handles: xaiworkspace://provision?env=dev (host=provision, path empty)
///          xaiworkspace:///provision?env=dev (host empty, path=/provision)
fn parse_deep_link(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "xaiworkspace" {
        return None;
    }
    // host_str() returns "provision" for xaiworkspace://provision?env=dev
    let is_provision = parsed.host_str() == Some("provision")
        || parsed.path().starts_with("/provision");
    if !is_provision {
        return None;
    }
    let env = parsed.query_pairs()
        .find(|(k, _)| k == "env")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| "prod".to_string());
    Some(env)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Deep link arrives as args when another instance tries to start
            if let Some(url) = args.get(1) {
                if let Some(env) = parse_deep_link(url) {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_provision(handle, env).await;
                    });
                    return;
                }
            }
            // No deep link — just focus existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_status])
        .setup(|app| {
            // Set up system tray (minimal — just "Open" + "Quit")
            let cfg = config::DesktopConfig::default();
            let oauth_mgr = Arc::new(oauth::OAuthManager::new(cfg.router_url.clone()));
            if let Err(e) = tray::setup(app.handle(), &cfg, oauth_mgr) {
                eprintln!("[Tray] Failed to set up system tray: {e}");
            }

            // Register deep link handler via plugin
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(env) = parse_deep_link(url.as_str()) {
                            let h = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_provision(h, env).await;
                            });
                            break;
                        }
                    }
                });
            }

            // Run startup (Docker install only, no bridge provisioning)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_setup(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

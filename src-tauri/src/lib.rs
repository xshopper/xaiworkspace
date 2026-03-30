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
    // Wait for webview to load before emitting events
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

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

    // Docker ready — hide window immediately (no need to show it)
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Handle deep link: xaiworkspace://provision?router=URL&app=URL&token=JWT
/// Called when user clicks "Add System" on the website.
async fn handle_provision(app: AppHandle, params: ProvisionParams) {
    let router_url = params.router_url;
    let app_url = params.app_url;
    let token = params.token;
    // Show the setup window and wait for it to be ready
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    // Brief delay so webview can load and start listening for events
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Provisioning bridge...",
        "percent": 10
    }));

    // Build config from the deep link parameters
    let mut cfg = config::DesktopConfig::default();
    cfg.router_url = router_url;
    cfg.app_url = app_url;
    if let Some(image) = params.image {
        cfg.bridge_image = image;
    }

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

    match bridge::create_new_bridge(&cfg, token.as_deref()).await {
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
        }
        Err(e) => {
            // Bridge container started but pairing failed — still usable
            let _ = app.emit("setup-progress", serde_json::json!({
                "step": "Bridge started (pairing pending)",
                "percent": 100
            }));
            eprintln!("[provision] Bridge pairing error: {e}");
        }
    }

    // Always hide window after provisioning attempt
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // Start OAuth listeners
    let oauth_mgr = Arc::new(oauth::OAuthManager::new(cfg.router_url.clone()));
    oauth_mgr.start_all(&cfg).await;
}

/// Parsed deep link parameters.
struct ProvisionParams {
    router_url: String,
    app_url: String,
    token: Option<String>,
    image: Option<String>,
}

/// Check if a URL belongs to an allowed domain.
fn is_allowed_url(url: &str) -> bool {
    let allowed = ["xaiworkspace.com", "xshopper.com", "localhost", "127.0.0.1"];
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return allowed.iter().any(|a| host == *a || host.ends_with(&format!(".{}", a)));
        }
    }
    false
}

/// Parse deep link URL and extract provision parameters.
/// Format: xaiworkspace://provision?router=URL&app=URL&token=JWT&image=IMAGE
fn parse_deep_link(url: &str) -> Option<ProvisionParams> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "xaiworkspace" {
        return None;
    }
    let is_provision = parsed.host_str() == Some("provision")
        || parsed.path().starts_with("/provision");
    if !is_provision {
        return None;
    }
    let router_url = parsed.query_pairs()
        .find(|(k, _)| k == "router")
        .map(|(_, v)| v.to_string())?;
    let app_url = parsed.query_pairs()
        .find(|(k, _)| k == "app")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| "https://xaiworkspace.com".to_string());

    // Validate URLs against allowed domains
    if !is_allowed_url(&router_url) {
        eprintln!("[deep-link] Rejected router URL with disallowed domain: {router_url}");
        return None;
    }
    if !is_allowed_url(&app_url) {
        eprintln!("[deep-link] Rejected app URL with disallowed domain: {app_url}");
        return None;
    }

    let token = parsed.query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string())
        .filter(|t| !t.is_empty());
    let image = parsed.query_pairs()
        .find(|(k, _)| k == "image")
        .map(|(_, v)| v.to_string());
    Some(ProvisionParams { router_url, app_url, token, image })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Deep link arrives as args when another instance tries to start
            if let Some(url) = args.get(1) {
                if let Some(params) = parse_deep_link(url) {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_provision(handle, params).await;
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

            // Register deep link scheme + handler
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Register scheme with OS (Linux/Windows — required for xdg-open/start to work)
                if let Err(e) = app.deep_link().register("xaiworkspace") {
                    eprintln!("[deep-link] Failed to register scheme: {e}");
                }

                // Check if app was launched with a deep link URL
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let handle = app.handle().clone();
                    for url in &urls {
                        if let Some(params) = parse_deep_link(url.as_str()) {
                            let h = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_provision(h, params).await;
                            });
                            break;
                        }
                    }
                }

                // Listen for subsequent deep link events (macOS + single-instance forwarding)
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(params) = parse_deep_link(url.as_str()) {
                            let h = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_provision(h, params).await;
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

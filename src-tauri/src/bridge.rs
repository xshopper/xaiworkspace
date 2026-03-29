use std::process::Command;
use tauri::{AppHandle, Emitter};
use crate::config::DesktopConfig;

const CONTAINER_NAME: &str = "xaiw-bridge";
const HEALTH_URL: &str = "http://localhost:3100/health";

/// Check if the bridge container is already running.
pub fn is_running() -> bool {
    Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Check if the bridge container exists (running or stopped).
fn container_exists() -> bool {
    Command::new("docker")
        .args(["inspect", CONTAINER_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Pull the bridge image and run the container.
/// Image name and ports come from config (router API or local override).
pub async fn run(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), String> {
    let image = &cfg.bridge_image;

    // Check if image exists locally first
    let image_exists = Command::new("docker")
        .args(["image", "inspect", image])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !image_exists {
        let _ = app.emit("setup-progress", serde_json::json!({
            "step": "Pulling bridge image...",
            "percent": 55
        }));

        let pull = Command::new("docker")
            .args(["pull", image])
            .status()
            .map_err(|e| format!("Failed to pull image: {e}"))?;

        if !pull.success() {
            return Err("Failed to pull bridge image. Check your internet connection and image registry access.".into());
        }
    }

    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Starting bridge...",
        "percent": 65
    }));

    if container_exists() {
        Command::new("docker")
            .args(["start", CONTAINER_NAME])
            .status()
            .map_err(|e| format!("Failed to start container: {e}"))?;
    } else {
        // Build port mapping + environment args from config
        let router_ws = cfg.router_url.replace("https://", "wss://").replace("http://", "ws://");
        let mut args = vec![
            "run".to_string(), "-d".into(),
            "--name".into(), CONTAINER_NAME.into(),
            "--restart".into(), "unless-stopped".into(),
            "-e".into(), format!("ROUTER_URL={}", cfg.router_url),
            "-e".into(), format!("ROUTER_WS={router_ws}/ws/gateway"),
            "-e".into(), format!("APP_URL={}", cfg.app_url),
        ];
        for port in &cfg.bridge_ports {
            args.push("-p".into());
            args.push(format!("{port}:{port}"));
        }
        args.push(image.to_string());

        let status = Command::new("docker")
            .args(&args)
            .status()
            .map_err(|e| format!("Failed to run container: {e}"))?;

        if !status.success() {
            return Err("Failed to create bridge container".into());
        }
    }

    Ok(())
}

/// Wait for the bridge health endpoint to respond.
pub async fn wait_for_health(app: &AppHandle, timeout_secs: u64) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Waiting for bridge...",
        "percent": 75
    }));

    let client = reqwest::Client::new();
    let start = std::time::Instant::now();

    loop {
        if let Ok(resp) = client.get(HEALTH_URL).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        if start.elapsed().as_secs() > timeout_secs {
            return Err("Bridge did not become healthy within timeout".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Open the bridge's localhost page in the default browser.
pub fn open_in_browser() {
    let _ = open::that("http://localhost:3100");
}

use std::process::Command;
use tauri::{AppHandle, Emitter};

const CONTAINER_NAME: &str = "xaiw-bridge";
const IMAGE: &str = "public.ecr.aws/s3b3q6t2/xaiworkspace-docker:latest";
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
///
/// If the container already exists but is stopped, start it.
/// If it doesn't exist, create it with all required port mappings.
pub async fn run(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Pulling bridge image...",
        "percent": 55
    }));

    // Pull latest image
    let pull = Command::new("docker")
        .args(["pull", IMAGE])
        .status()
        .map_err(|e| format!("Failed to pull image: {e}"))?;

    if !pull.success() {
        return Err("Failed to pull bridge image".into());
    }

    let _ = app.emit("setup-progress", serde_json::json!({
        "step": "Starting bridge...",
        "percent": 65
    }));

    if container_exists() {
        // Container exists — just start it
        Command::new("docker")
            .args(["start", CONTAINER_NAME])
            .status()
            .map_err(|e| format!("Failed to start container: {e}"))?;
    } else {
        // Create new container with all port mappings:
        // 3100  — bridge web (pairing redirect + health)
        // 54545 — Claude OAuth callback
        // 8085  — Gemini OAuth callback
        // 1455  — Codex OAuth callback
        let status = Command::new("docker")
            .args([
                "run", "-d",
                "--name", CONTAINER_NAME,
                "--restart", "unless-stopped",
                "-p", "3100:3100",
                "-p", "54545:54545",
                "-p", "8085:8085",
                "-p", "1455:1455",
                IMAGE,
            ])
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
/// The bridge serves a redirect to https://app.xaiworkspace.com/link?code=XXXX
pub fn open_in_browser() {
    let _ = open::that("http://localhost:3100");
}

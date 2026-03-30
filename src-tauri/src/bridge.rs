use std::process::Command;
use crate::config::DesktopConfig;

/// Generate a unique bridge name like `xaiw-bridge-a3f8b1c2`.
fn unique_bridge_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("xaiw-bridge-{:x}", ts & 0xFFFF_FFFF)
}

/// Fetch the router secret via the authenticated /api/config/provision endpoint.
/// Uses the user's JWT token from the deep link to authenticate.
async fn fetch_router_secret(router_url: &str, token: &str) -> Result<String, String> {
    let url = format!("{router_url}/api/config/provision");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch provision config: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Provision config request failed: {status} {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse provision config: {e}"))?;

    json["routerSecret"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "routerSecret not found in provision config".into())
}

/// Create a new bridge container that registers with the router.
/// Returns the pairing URL (e.g. http://localhost:4200/link?code=XXXX).
///
/// If a JWT `token` is provided (from deep link), it is used to fetch the
/// router secret from the authenticated /api/config/provision endpoint.
/// Falls back to ROUTER_SECRET env var if no token is available.
pub async fn create_new_bridge(cfg: &DesktopConfig, token: Option<&str>) -> Result<String, String> {
    let app_url = &cfg.app_url;

    // Check if a bridge is already running on this Docker host
    if let Ok(output) = Command::new("docker")
        .args(["ps", "--filter", "name=xaiw-bridge", "--filter", "status=running", "--format", "{{.Names}}"])
        .output()
    {
        let existing = String::from_utf8_lossy(&output.stdout);
        let running: Vec<&str> = existing.trim().lines().collect();
        if !running.is_empty() {
            let bridge_name = running[0];
            eprintln!("[bridge] Bridge already running: {bridge_name} — reusing instead of creating new");
            // Try to get its pairing code
            if let Ok(out) = Command::new("docker")
                .args(["exec", bridge_name, "curl", "-sf", "http://localhost:3100/pairing-code"])
                .output()
            {
                if out.status.success() {
                    let body = String::from_utf8_lossy(&out.stdout);
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                        if let Some(code) = json["code"].as_str() {
                            if !code.is_empty() {
                                return Ok(format!("{app_url}/link?code={code}"));
                            }
                        }
                    }
                }
            }
            // Bridge is running but no pairing code yet — wait for it
            return wait_for_pairing(bridge_name, app_url).await;
        }
    }

    let name = unique_bridge_name();
    let image = &cfg.bridge_image;
    let router_url = &cfg.router_url;

    // Get router secret: prefer fetching via authenticated endpoint, fall back to env var
    let router_secret = if let Some(jwt) = token {
        match fetch_router_secret(router_url, jwt).await {
            Ok(secret) => {
                eprintln!("[bridge] Fetched router secret via authenticated endpoint");
                secret
            }
            Err(e) => {
                eprintln!("[bridge] Warning: failed to fetch secret ({e}), falling back to env var");
                std::env::var("ROUTER_SECRET").unwrap_or_default()
            }
        }
    } else {
        std::env::var("ROUTER_SECRET").unwrap_or_default()
    };

    if let Some(compose_dir) = &cfg.compose_dir {
        // Compose mode: resolve Docker network, run on the same network as the stack
        let network = Command::new("docker")
            .args(["compose", "config", "--format", "json"])
            .current_dir(compose_dir)
            .output()
            .ok()
            .and_then(|o| {
                let json: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
                // Extract first network name from compose config
                json["networks"].as_object()?.keys().next().map(|k| k.to_string())
            })
            .unwrap_or_else(|| "xai-dev".to_string());

        let status = Command::new("docker")
            .args([
                "run", "-d",
                "--name", &name,
                "--network", &network,
                "--restart", "unless-stopped",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                "-e", &format!("INSTANCE_ID={name}"),
                "-e", &format!("ROUTER_URL={router_url}"),
                "-e", &format!("APP_URL={app_url}"),
                "-e", &format!("ROUTER_SECRET={router_secret}"),
                image,
            ])
            .status()
            .map_err(|e| format!("Failed to create bridge: {e}"))?;

        if !status.success() {
            return Err("Failed to create bridge container".into());
        }
    } else {
        // Standalone mode (production): pull image if needed, run with port mapping
        let image_exists = Command::new("docker")
            .args(["image", "inspect", image])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !image_exists {
            let pull = Command::new("docker")
                .args(["pull", image])
                .status()
                .map_err(|e| format!("Failed to pull image: {e}"))?;
            if !pull.success() {
                return Err("Failed to pull bridge image".into());
            }
        }

        let status = Command::new("docker")
            .args([
                "run", "-d",
                "--name", &name,
                "--restart", "unless-stopped",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                "-p", "3100:3100",     // Pairing server
                "-p", "54545:54545",   // Claude OAuth callback
                "-p", "8085:8085",     // Gemini OAuth callback
                "-p", "1455:1455",     // Codex OAuth callback
                "-e", &format!("INSTANCE_ID={name}"),
                "-e", &format!("ROUTER_URL={router_url}"),
                "-e", &format!("APP_URL={app_url}"),
                "-e", &format!("ROUTER_SECRET={router_secret}"),
                image,
            ])
            .status()
            .map_err(|e| format!("Failed to create bridge: {e}"))?;

        if !status.success() {
            return Err("Failed to create bridge container".into());
        }
    }

    wait_for_pairing(&name, app_url).await
}

/// Wait for a bridge container to register and return its pairing URL.
async fn wait_for_pairing(bridge_name: &str, app_url: &str) -> Result<String, String> {
    let start = std::time::Instant::now();
    loop {
        let output = Command::new("docker")
            .args(["exec", bridge_name, "curl", "-sf", "http://localhost:3100/pairing-code"])
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(code) = json["code"].as_str() {
                        if !code.is_empty() {
                            return Ok(format!("{app_url}/link?code={code}"));
                        }
                    }
                }
            }
        }

        if start.elapsed().as_secs() > 60 {
            return Err(format!("Bridge {bridge_name} did not register within 60s"));
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

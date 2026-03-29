use std::process::Command;
use crate::config::DesktopConfig;

/// Generate a unique bridge name like `xaiw-bridge-a3f8b1c2`.
fn unique_bridge_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("xaiw-bridge-{:x}", ts & 0xFFFF_FFFF)
}

/// Create a new bridge container that registers with the router.
/// Returns the pairing URL (e.g. http://localhost:4200/link?code=XXXX).
pub async fn create_new_bridge(cfg: &DesktopConfig) -> Result<String, String> {
    let name = unique_bridge_name();
    let image = &cfg.bridge_image;
    let router_url = &cfg.router_url;
    let router_secret = std::env::var("ROUTER_SECRET").unwrap_or_default();
    let app_url = &cfg.app_url;

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

    // Wait for the bridge to register and get a pairing code
    let start = std::time::Instant::now();
    loop {
        let output = Command::new("docker")
            .args(["exec", &name, "curl", "-sf", "http://localhost:3100/pairing-code"])
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
            return Err("Bridge did not register within 60s".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

use std::process::Command;
use crate::config::DesktopConfig;

/// Response from POST /api/bridges
#[derive(Debug)]
struct BridgeProvision {
    bridge_id: String,
    bridge_token: String,
    pairing_code: String,
}

/// Create a bridge via the router's POST /api/bridges endpoint.
/// Uses the user's JWT token from the deep link to authenticate.
/// Returns bridge ID, bridge token, and pairing code.
async fn provision_bridge(router_url: &str, token: &str) -> Result<BridgeProvision, String> {
    let url = format!("{router_url}/api/bridges");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"provider":"local","region":"local"}"#)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Failed to create bridge: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Bridge creation failed: {status} {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse bridge response: {e}"))?;

    let bridge_id = json["bridgeId"]
        .as_str()
        .ok_or("bridgeId not found in response")?
        .to_string();
    let bridge_token = json["bridgeToken"]
        .as_str()
        .ok_or("bridgeToken not found in response")?
        .to_string();
    let pairing_code = json["pairingCode"]
        .as_str()
        .ok_or("pairingCode not found in response")?
        .to_string();

    Ok(BridgeProvision { bridge_id, bridge_token, pairing_code })
}

/// Create a new bridge container that registers with the router.
/// Returns the pairing URL (e.g. http://localhost:4200/link?code=XXXX).
///
/// Uses POST /api/bridges to create the bridge server-side (gets a per-bridge
/// BRIDGE_TOKEN), then launches the Docker container with that token.
/// No ROUTER_SECRET is needed — the bridge authenticates with its own token.
pub async fn create_new_bridge(cfg: &DesktopConfig, token: Option<&str>) -> Result<String, String> {
    let app_url = &cfg.app_url;

    let image = &cfg.bridge_image;

    // Check if a bridge is already running on this Docker host
    if let Ok(output) = Command::new("docker")
        .args(["ps", "--filter", "name=bridge", "--filter", "status=running", "--format", "{{.Names}}"])
        .output()
    {
        let existing = String::from_utf8_lossy(&output.stdout);
        let running: Vec<&str> = existing.trim().lines().collect();
        if !running.is_empty() {
            let bridge_name = running[0];
            eprintln!("[bridge] Bridge already running: {bridge_name} — reusing");
            let router_url = cfg.router_urls.first().map(|s| s.as_str()).unwrap_or("https://router.xaiworkspace.com");

            if let Some(jwt) = token {
                // Query the router API for bridge status — avoids depending on the container's
                // /pairing-code endpoint (which varies by image version and auth scheme).
                match get_bridge_info(router_url, jwt, bridge_name).await {
                    BridgeInfo::Member => {
                        eprintln!("[bridge] Already a member of {bridge_name}");
                        return Ok(String::new());
                    }
                    BridgeInfo::HasCode(code) => {
                        // Bridge visible but user not a member — claim it
                        match claim_bridge(router_url, jwt, &code).await {
                            Ok(_) => {
                                eprintln!("[bridge] Claimed bridge {bridge_name} via API");
                                return Ok(String::new());
                            }
                            Err(e) if e.contains("409") => {
                                eprintln!("[bridge] Already a member of {bridge_name}");
                                return Ok(String::new());
                            }
                            Err(e) => {
                                eprintln!("[bridge] API claim failed: {e}");
                                return Ok(format!("{app_url}/link?code={code}"));
                            }
                        }
                    }
                    BridgeInfo::NotFound => {
                        // Bridge not visible to user — remove old container and reprovision fresh
                        eprintln!("[bridge] Not a member of {bridge_name} — removing and reprovisioning");
                        let _ = Command::new("docker").args(["rm", "-f", bridge_name]).status();
                        // Fall through to create a new bridge below
                    }
                }
            } else {
                // No JWT — can't claim via API, open browser instead
                return Ok(format!("{app_url}/link?code="));
            }
        }
    }

    // No bridge running — pull latest image before creating
    let _ = Command::new("docker").args(["pull", image]).status();

    let jwt = token.ok_or("JWT token required to create a bridge — launch via deep link")?;
    let router_url = cfg.router_urls.first().map(|s| s.as_str()).unwrap_or("https://router.xaiworkspace.com");
    let router_urls_env = cfg.router_urls.join(",");

    // Create bridge server-side — gets per-bridge BRIDGE_TOKEN (not the master ROUTER_SECRET)
    let provision = provision_bridge(router_url, jwt).await?;
    eprintln!("[bridge] Bridge created: {} (code: {})", provision.bridge_id, provision.pairing_code);

    // Claim BEFORE starting the container — the pairing code is valid now but the bridge
    // will re-register with a new code once the container connects to the router.
    match claim_bridge(router_url, jwt, &provision.pairing_code).await {
        Ok(_) => eprintln!("[bridge] Claimed bridge {} via API", provision.bridge_id),
        Err(e) if e.contains("409") => eprintln!("[bridge] Already a member of {}", provision.bridge_id),
        Err(e) => eprintln!("[bridge] Claim warning: {e}"),
    }

    let name = &provision.bridge_id;

    let container_result = if let Some(compose_dir) = &cfg.compose_dir {
        // Compose mode: resolve Docker network, run on the same network as the stack
        let network = Command::new("docker")
            .args(["compose", "config", "--format", "json"])
            .current_dir(compose_dir)
            .output()
            .ok()
            .and_then(|o| {
                let json: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
                json["networks"].as_object()?.keys().next().map(|k| k.to_string())
            })
            .unwrap_or_else(|| "xai-dev".to_string());

        Command::new("docker")
            .args([
                "run", "-d", "--pull", "always",
                "--name", name,
                "--network", &network,
                "--restart", "unless-stopped",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                "-e", &format!("BRIDGE_ID={name}"),
                "-e", &format!("BRIDGE_TOKEN={}", provision.bridge_token),
                "-e", &format!("ROUTER_URLS={router_urls_env}"),
                "-e", &format!("APP_URL={app_url}"),
                image,
            ])
            .status()
            .map_err(|e| format!("Failed to create bridge: {e}"))?
    } else {
        // Standalone mode
        Command::new("docker")
            .args([
                "run", "-d", "--pull", "always",
                "--name", name,
                "--restart", "unless-stopped",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                "-p", "3100:3100",     // Pairing server
                "-e", &format!("BRIDGE_ID={name}"),
                "-e", &format!("BRIDGE_TOKEN={}", provision.bridge_token),
                "-e", &format!("ROUTER_URLS={router_urls_env}"),
                "-e", &format!("APP_URL={app_url}"),
                image,
            ])
            .status()
            .map_err(|e| format!("Failed to create bridge: {e}"))?
    };

    if !container_result.success() {
        return Err("Failed to create bridge container".into());
    }

    Ok(String::new())
}

/// Claim a bridge via the router's POST /api/instances/claim endpoint.
async fn claim_bridge(router_url: &str, token: &str, code: &str) -> Result<(), String> {
    let url = format!("{router_url}/api/instances/claim");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "code": code }).to_string())
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Claim request failed: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("{status} {body}"))
    }
}

enum BridgeInfo {
    Member,
    HasCode(String),
    NotFound,
}

/// Query GET /api/instances to check bridge status for the current user.
async fn get_bridge_info(router_url: &str, token: &str, bridge_name: &str) -> BridgeInfo {
    let url = format!("{router_url}/api/instances");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            if let Ok(json) = r.json::<serde_json::Value>().await {
                if let Some(arr) = json["instances"].as_array() {
                    if arr.iter().any(|i| {
                        i["instanceId"].as_str() == Some(bridge_name) && i["isBridge"].as_bool() == Some(true)
                    }) {
                        // Bridge is in user's instances list — they're a member
                        return BridgeInfo::Member;
                    }
                    // Bridge not in user's list — check if any bridge has a pairing code we can use
                    // (non-local bridges are visible to all users even without membership)
                    for inst in arr {
                        if inst["instanceId"].as_str() == Some(bridge_name) {
                            if let Some(code) = inst["pairingCode"].as_str() {
                                if !code.is_empty() {
                                    return BridgeInfo::HasCode(code.to_string());
                                }
                            }
                        }
                    }
                }
            }
            BridgeInfo::NotFound
        }
        _ => BridgeInfo::NotFound,
    }
}

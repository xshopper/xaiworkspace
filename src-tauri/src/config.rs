use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const ROUTER_URL: &str = "https://router.xaiworkspace.com";
const CONFIG_ENDPOINT: &str = "/api/config/desktop";
const LOCAL_CONFIG_FILE: &str = "xaiworkspace-config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub bridge_image: String,
    pub bridge_ports: Vec<u16>,
    pub oauth_providers: Vec<OAuthProvider>,
    pub router_url: String,
    pub app_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProvider {
    pub name: String,
    pub port: u16,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            bridge_image: "public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest".into(),
            bridge_ports: vec![3100, 54545, 8085, 1455],
            oauth_providers: vec![
                OAuthProvider { name: "claude".into(), port: 54545 },
                OAuthProvider { name: "gemini".into(), port: 8085 },
                OAuthProvider { name: "codex".into(), port: 1455 },
            ],
            router_url: ROUTER_URL.into(),
            app_url: "https://app.xaiworkspace.com".into(),
        }
    }
}

/// Load config with priority: local file > router API > defaults.
pub async fn load() -> DesktopConfig {
    // 1. Try local config file (dev/test override)
    if let Some(local) = load_local_file() {
        println!("[config] Loaded from local file: {}", local_config_path().display());
        return local;
    }

    // 2. Try router API
    match load_from_router().await {
        Ok(config) => {
            println!("[config] Loaded from router: {ROUTER_URL}{CONFIG_ENDPOINT}");
            config
        }
        Err(e) => {
            println!("[config] Router config failed ({e}), using defaults");
            DesktopConfig::default()
        }
    }
}

/// Path to local config file — next to the executable or in working dir.
fn local_config_path() -> PathBuf {
    // Check next to executable first
    if let Ok(exe) = std::env::current_exe() {
        let beside_exe = exe.parent().unwrap_or(exe.as_ref()).join(LOCAL_CONFIG_FILE);
        if beside_exe.exists() {
            return beside_exe;
        }
    }
    // Fall back to working directory
    PathBuf::from(LOCAL_CONFIG_FILE)
}

fn load_local_file() -> Option<DesktopConfig> {
    let path = local_config_path();
    let content = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<DesktopConfig>(&content) {
        Ok(config) => Some(config),
        Err(e) => {
            eprintln!("[config] Failed to parse {}: {e}", path.display());
            None
        }
    }
}

async fn load_from_router() -> Result<DesktopConfig, String> {
    let url = format!("{ROUTER_URL}{CONFIG_ENDPOINT}");
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    resp.json::<DesktopConfig>().await.map_err(|e| e.to_string())
}

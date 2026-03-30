#![allow(dead_code)]

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
    /// Path to docker-compose.yml directory. When set, bridge is managed via
    /// `docker compose` instead of `docker run`, joining the compose stack.
    #[serde(default)]
    pub compose_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProvider {
    pub name: String,
    pub port: u16,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            bridge_image: "public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-v0.1.0".into(),
            bridge_ports: vec![3100, 54545, 8085, 1455],
            oauth_providers: vec![
                OAuthProvider { name: "claude".into(), port: 54545 },
                OAuthProvider { name: "gemini".into(), port: 8085 },
                OAuthProvider { name: "codex".into(), port: 1455 },
            ],
            router_url: ROUTER_URL.into(),
            app_url: "https://xaiworkspace.com".into(),
            compose_dir: None,
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

/// Load config for a specific environment (dev/test/prod).
/// Tries: local config/env.json > router API > defaults.
pub async fn load_env(env: &str) -> DesktopConfig {
    // Try local config file: config/dev.json, config/test.json, config/prod.json
    let env_file = format!("config/{env}.json");
    for dir in [std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())), Some(PathBuf::from("."))].into_iter().flatten() {
        let path = dir.join(&env_file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<DesktopConfig>(&content) {
                println!("[config] Loaded {env} config from {}", path.display());
                return cfg;
            }
        }
    }

    // Determine router URL by environment
    let router_url = match env {
        "dev" => "http://localhost:8080",
        "test" => "https://router-test.xaiworkspace.com",
        _ => ROUTER_URL,
    };

    // Try router API
    let url = format!("{router_url}{CONFIG_ENDPOINT}");
    if let Ok(resp) = reqwest::Client::new().get(&url).timeout(std::time::Duration::from_secs(5)).send().await {
        if let Ok(cfg) = resp.json::<DesktopConfig>().await {
            println!("[config] Loaded {env} config from router");
            return cfg;
        }
    }

    // Defaults per environment
    let mut cfg = DesktopConfig::default();
    match env {
        "dev" => {
            cfg.bridge_image = "xaiworkspace-bridge:latest".into();
            cfg.router_url = "http://localhost:8080".into();
            cfg.app_url = "http://localhost:4200".into();
        }
        "test" => {
            cfg.router_url = "https://router-test.xaiworkspace.com".into();
            cfg.app_url = "https://xaiworkspace.com".into();
        }
        _ => {} // prod defaults are already set
    }
    println!("[config] Using {env} defaults");
    cfg
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

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const LOCAL_CONFIG_FILE: &str = "xaiworkspace-config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub bridge_image: String,
    pub bridge_ports: Vec<u16>,
    pub router_url: String,
    pub app_url: String,
    /// Path to docker-compose.yml directory. When set, bridge is managed via
    /// `docker compose` instead of `docker run`, joining the compose stack.
    #[serde(default)]
    pub compose_dir: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            bridge_image: "public.ecr.aws/s3b3q6t2/xaiworkspace-docker:bridge-latest".into(),
            bridge_ports: vec![3100, 54545, 8085, 1455],
            router_url: "https://router.xaiworkspace.com".into(),
            app_url: "https://xaiworkspace.com".into(),
            compose_dir: None,
        }
    }
}

/// Load config: local file > router API > defaults.
pub fn load() -> DesktopConfig {
    if let Some(local) = load_local_file() {
        println!("[config] Loaded from local file: {}", local_config_path().display());
        return local;
    }
    // Try fetching from router to get the latest bridge image version
    let defaults = DesktopConfig::default();
    match fetch_router_config(&defaults.router_url) {
        Some(remote) => {
            println!("[config] Loaded from router: {}", defaults.router_url);
            remote
        }
        None => {
            println!("[config] Using defaults");
            defaults
        }
    }
}

/// Fetch config from router's /api/config/desktop endpoint.
fn fetch_router_config(router_url: &str) -> Option<DesktopConfig> {
    let url = format!("{}/api/config/desktop", router_url.trim_end_matches('/'));
    let output = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "5", &url])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    serde_json::from_slice(&output.stdout).ok()
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

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub bridge_image: String,
    pub bridge_ports: Vec<u16>,
    /// Comma-separated list of router URLs for multi-router bridge support.
    pub router_urls: Vec<String>,
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
            bridge_ports: vec![3100],
            router_urls: vec!["https://router.xaiworkspace.com".into()],
            app_url: "https://xaiworkspace.com".into(),
            compose_dir: None,
        }
    }
}

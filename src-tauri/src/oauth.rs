use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use crate::config::DesktopConfig;

const SUCCESS_HTML: &str = r##"<!DOCTYPE html>
<html>
<head><title>Connected</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; background: #f8f9fa; }
  .card { text-align: center; padding: 40px; background: #fff; border-radius: 16px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .check { width: 48px; height: 48px; background: #22c55e; border-radius: 50%;
           display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; }
  h2 { margin: 0 0 8px; font-size: 20px; }
  p { color: #666; font-size: 14px; margin: 0; }
</style></head>
<body>
  <div class="card">
    <div class="check"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#fff" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div>
    <h2>Connected!</h2>
    <p>You can close this tab.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>"##;

const ERROR_HTML: &str = r##"<!DOCTYPE html>
<html>
<head><title>Error</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; background: #f8f9fa; }
  .card { text-align: center; padding: 40px; background: #fff; border-radius: 16px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  h2 { margin: 0 0 8px; font-size: 20px; color: #dc3545; }
  p { color: #666; font-size: 14px; margin: 0; }
</style></head>
<body>
  <div class="card"><h2>Connection Failed</h2><p>Please try again.</p></div>
</body>
</html>"##;

/// Tracks running OAuth listeners so they can be toggled on/off.
#[derive(Clone)]
pub struct OAuthManager {
    /// provider name → (port, cancellation token if running)
    listeners: Arc<Mutex<HashMap<String, ListenerState>>>,
    router_url: String,
}

struct ListenerState {
    port: u16,
    token: Option<CancellationToken>,
}

impl OAuthManager {
    pub fn new(router_url: String) -> Self {
        Self {
            listeners: Arc::new(Mutex::new(HashMap::new())),
            router_url,
        }
    }

    /// Start all OAuth listeners from config. Default: all on.
    pub async fn start_all(&self, cfg: &DesktopConfig) {
        let mut map = self.listeners.lock().await;
        for provider in &cfg.oauth_providers {
            let token = CancellationToken::new();
            let name = provider.name.clone();
            let port = provider.port;
            let url = self.router_url.clone();
            let cancel = token.clone();

            tokio::spawn(listen_on_port(name.clone(), port, url, cancel));

            map.insert(name, ListenerState { port, token: Some(token) });
        }
    }

    /// Toggle a provider's OAuth listener on or off. Returns new state.
    pub async fn toggle(&self, provider: &str) -> bool {
        let mut map = self.listeners.lock().await;
        if let Some(state) = map.get_mut(provider) {
            if let Some(token) = state.token.take() {
                // Currently on → turn off
                token.cancel();
                println!("[OAuth] Stopped listener for {provider} (port {})", state.port);
                false
            } else {
                // Currently off → turn on
                let token = CancellationToken::new();
                let name = provider.to_string();
                let port = state.port;
                let url = self.router_url.clone();
                let cancel = token.clone();

                tokio::spawn(listen_on_port(name, port, url, cancel));

                state.token = Some(token);
                println!("[OAuth] Started listener for {provider} (port {})", state.port);
                true
            }
        } else {
            false
        }
    }

    /// Check if a provider's listener is currently active.
    pub async fn is_active(&self, provider: &str) -> bool {
        let map = self.listeners.lock().await;
        map.get(provider).map(|s| s.token.is_some()).unwrap_or(false)
    }

    /// Get all providers with their current state.
    pub async fn status(&self) -> Vec<(String, u16, bool)> {
        let map = self.listeners.lock().await;
        map.iter()
            .map(|(name, state)| (name.clone(), state.port, state.token.is_some()))
            .collect()
    }
}

async fn listen_on_port(provider: String, port: u16, router_url: String, cancel: CancellationToken) {
    let addr = format!("127.0.0.1:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            println!("[OAuth] Listening on {addr} for {provider}");
            l
        }
        Err(e) => {
            eprintln!("[OAuth] Failed to bind {addr} for {provider}: {e}");
            return;
        }
    };

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                println!("[OAuth] Listener for {provider} (port {port}) cancelled");
                return;
            }
            result = listener.accept() => {
                let (mut stream, _) = match result {
                    Ok(conn) => conn,
                    Err(_) => continue,
                };

                let provider = provider.clone();
                let router = router_url.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = match stream.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };

                    let request = String::from_utf8_lossy(&buf[..n]);
                    let (code, state) = parse_callback(&request);
                    let (status, body) = if let Some(code) = code {
                        match forward_to_router(&router, &provider, &code, state.as_deref()).await {
                            Ok(_) => ("200 OK", SUCCESS_HTML),
                            Err(_) => ("500 Internal Server Error", ERROR_HTML),
                        }
                    } else {
                        ("400 Bad Request", ERROR_HTML)
                    };

                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        }
    }
}

fn parse_callback(request: &str) -> (Option<String>, Option<String>) {
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    let query = match path.split_once('?') {
        Some((_, q)) => q,
        None => return (None, None),
    };

    let mut code = None;
    let mut state = None;

    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "code" => code = Some(urlencoding_decode(value)),
                "state" => state = Some(urlencoding_decode(value)),
                _ => {}
            }
        }
    }

    (code, state)
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

async fn forward_to_router(
    router_url: &str,
    provider: &str,
    code: &str,
    state: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{router_url}/oauth/bridge/{provider}");

    let router_secret = std::env::var("ROUTER_SECRET").unwrap_or_else(|_| {
        eprintln!("[OAuth] WARNING: ROUTER_SECRET env var not set — OAuth callback forwarding will fail auth");
        String::new()
    });

    let mut body = serde_json::json!({ "code": code });
    if let Some(s) = state {
        body["state"] = serde_json::Value::String(s.to_string());
    }

    let resp = client
        .post(&url)
        .header("x-router-secret", &router_secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Router returned {}", resp.status()))
    }
}

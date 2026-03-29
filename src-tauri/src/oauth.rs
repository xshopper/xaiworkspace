use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

/// Start OAuth listeners on all provider ports from config.
/// Spawns a background task per port; returns immediately.
/// Ports already bound by the bridge container are silently skipped.
pub fn start_listeners(cfg: &DesktopConfig) {
    let router_url = cfg.router_url.clone();
    for provider in &cfg.oauth_providers {
        let name = provider.name.clone();
        let port = provider.port;
        let url = router_url.clone();
        tokio::spawn(listen_on_port(name, port, url));
    }
}

async fn listen_on_port(provider: String, port: u16, router_url: String) {
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
        let (mut stream, _) = match listener.accept().await {
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

            // Parse GET /callback?code=XXX&state=YYY from the HTTP request line
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

/// Parse code and state from an HTTP request line.
/// Expects: GET /callback?code=XXX&state=YYY HTTP/1.1
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

/// Minimal URL decoding (handles %XX sequences).
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

/// Forward the OAuth code to the router API.
async fn forward_to_router(
    router_url: &str,
    provider: &str,
    code: &str,
    state: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{router_url}/oauth/bridge/{provider}");

    // Router secret for authentication — read from env or use default for local dev
    let router_secret = std::env::var("ROUTER_SECRET").unwrap_or_default();

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

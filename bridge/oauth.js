#!/usr/bin/env node
/**
 * OAuth callback listener — intercepts OAuth redirects on provider ports and
 * forwards authorization codes to the correct router.
 *
 * Ports:
 *   54545 — Claude
 *    8085 — Gemini
 *    1455 — Codex
 *
 * Multi-router flow:
 *   1. Router sends `expect_oauth { provider, routerUrl, routerSecret }` to bridge.js
 *   2. bridge.js writes to /data/pending_oauth.json
 *   3. OAuth provider redirects browser to http://localhost:{port}?code=XXX[&state=YYY]
 *   4. This listener reads pending_oauth.json to find the target router
 *   5. Forwards { code, state } to POST {routerUrl}/oauth/bridge/{provider}
 *   6. Returns success/error HTML to the browser
 */
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const ROUTERS_FILE = '/data/routers.json';
const PENDING_OAUTH_FILE = '/data/pending_oauth.json';

/**
 * Get pending OAuth entry for a provider (written by bridge.js).
 * Looks up by provider:state first (precise match), then provider (fallback).
 * Returns { routerUrl } or null if expired/missing.
 */
function getPendingOAuth(provider, state) {
  try {
    const pending = JSON.parse(fs.readFileSync(PENDING_OAUTH_FILE, 'utf8'));
    // Try precise match first (provider:state)
    if (state) {
      const precise = pending[`${provider}:${state}`];
      if (precise && (Date.now() - precise.ts) < 600_000) return precise;
    }
    // Fall back to provider-only key
    const entry = pending[provider];
    if (entry && (Date.now() - entry.ts) < 600_000) return entry;
  } catch {}
  return null;
}

/**
 * Get bridge credentials for a specific router URL from routers.json.
 * Returns { bridgeId, bridgeToken } or null.
 */
function getRouterCredentials(routerUrl) {
  try {
    const routers = JSON.parse(fs.readFileSync(ROUTERS_FILE, 'utf8'));
    return routers.find(r => r.routerUrl === routerUrl) || null;
  } catch {}
  return null;
}

// Provider → port mapping
const PROVIDERS = [
  { name: 'claude', port: 54545 },
  { name: 'gemini', port: 8085 },
  { name: 'codex', port: 1455 },
];

// Validation constants
const MAX_CODE_LENGTH = 2048;
const MAX_RETRIES = 5;

const SUCCESS_HTML = `<!DOCTYPE html>
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
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
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
</html>`;

/**
 * Validate OAuth authorization code format.
 */
function isValidCode(code) {
  if (!code || typeof code !== 'string') return false;
  if (code.length > MAX_CODE_LENGTH) return false;
  return /^[a-zA-Z0-9\-_\.~+/=]+$/.test(code);
}

/**
 * Forward OAuth code to the correct router for token exchange.
 * Uses pending_oauth.json to determine which router initiated the flow.
 */
async function forwardToRouter(provider, code, state) {
  const pending = getPendingOAuth(provider, state);
  if (!pending?.routerUrl) {
    throw new Error(`No pending OAuth for ${provider} — expect_oauth may have been missed or expired`);
  }
  const routerUrl = pending.routerUrl;

  // Authenticate with per-bridge credentials (bridgeToken) for this specific router.
  const creds = getRouterCredentials(routerUrl);
  if (!creds) {
    throw new Error(`No credentials for router ${routerUrl} — not registered in routers.json`);
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-bridge-token': creds.bridgeToken,
    'x-bridge-id': creds.bridgeId,
  };

  const url = `${routerUrl}/oauth/bridge/${encodeURIComponent(provider)}`;
  const body = { code };
  if (state) body.state = state;

  console.log(`[oauth] ${provider}: forwarding to ${routerUrl}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Router returned ${resp.status}: ${text}`);
  }
}

/**
 * Start an HTTP server for a single OAuth provider on the given port.
 */
function startProviderListener(provider, port, attempt = 1) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Parse query string from the callback URL
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://localhost:${port}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML);
      return;
    }

    const code = parsedUrl.searchParams.get('code');
    const state = parsedUrl.searchParams.get('state');

    if (!code) {
      // Not an OAuth callback — might be a health check or favicon
      if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, provider }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML);
      return;
    }

    // Validate code parameter
    if (!isValidCode(code)) {
      console.error(`[oauth] ${provider}: callback rejected — invalid code format (length=${code.length})`);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML);
      return;
    }

    // Note: state is optional — some providers (Claude) may not return it.
    // Do not reject callbacks without state.

    // Forward to the correct router
    try {
      await forwardToRouter(provider, code, state);
      console.log(`[oauth] ${provider}: callback forwarded successfully`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);
    } catch (err) {
      console.error(`[oauth] ${provider}: forward failed:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[oauth] Listening on port ${port} for ${provider}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_RETRIES) {
      console.warn(`[oauth] Port ${port} in use for ${provider} — retry ${attempt}/${MAX_RETRIES} in 10s`);
      setTimeout(() => startProviderListener(provider, port, attempt + 1), 10000);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`[oauth] Port ${port} for ${provider} — giving up after ${MAX_RETRIES} retries`);
    } else {
      console.error(`[oauth] ${provider} server error:`, err.message);
    }
  });

  return server;
}

// Start all provider listeners
for (const { name, port } of PROVIDERS) {
  startProviderListener(name, port);
}

console.log('[oauth] OAuth callback listeners started (multi-router)');

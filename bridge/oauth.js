#!/usr/bin/env node
/**
 * OAuth callback listener — intercepts OAuth redirects on provider ports and
 * forwards authorization codes to the router.
 *
 * Ports:
 *   54545 — Claude
 *    8085 — Gemini
 *    1455 — Codex
 *
 * Flow:
 *   1. OAuth provider redirects browser to http://localhost:{port}?code=XXX&state=YYY
 *   2. This listener validates the state parameter format (defense-in-depth)
 *   3. Forwards { code, state } to POST {ROUTER_URL}/oauth/bridge/{provider}
 *   4. Returns success/error HTML to the browser
 */
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const ROUTER_URL = process.env.ROUTER_URL;
if (!ROUTER_URL) {
  console.error('[oauth] FATAL: ROUTER_URL is required');
  process.exit(1);
}

const APP_URL = process.env.APP_URL || 'https://xaiworkspace.com';

// Read router secret: env var first, then Docker secret file
const SECRETS_FILE_PATH = '/run/secrets/router_secret';
const ROUTER_SECRET = process.env.ROUTER_SECRET
  || (() => {
    try { return fs.readFileSync(SECRETS_FILE_PATH, 'utf8').trim(); }
    catch { return ''; }
  })();

if (!ROUTER_SECRET) {
  console.warn('[oauth] WARNING: ROUTER_SECRET not set — OAuth callbacks will be rejected');
}

// Allowed CORS origins — restrict to known app URLs and localhost for dev
const ALLOWED_ORIGINS = new Set([
  APP_URL,
  ROUTER_URL,
  'http://localhost:4200',
  'http://localhost:3000',
  'https://xaiworkspace.com',
  'https://app-test.xaiworkspace.com',
]);

// Provider → port mapping
const PROVIDERS = [
  { name: 'claude', port: 54545 },
  { name: 'gemini', port: 8085 },
  { name: 'codex', port: 1455 },
];

// Validation constants
const MIN_STATE_LENGTH = 8;
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
 * Validate OAuth state parameter format (defense-in-depth).
 * Accepts alphanumeric + URL-safe chars including base64url.
 * The router performs the authoritative state check server-side.
 */
function isValidState(state) {
  if (!state || state.length < MIN_STATE_LENGTH) return false;
  // Allow alphanumeric, dash, underscore, dot, tilde, plus, slash, equals (base64)
  return /^[a-zA-Z0-9\-_\.~+/=]+$/.test(state);
}

/**
 * Validate OAuth authorization code format.
 */
function isValidCode(code) {
  if (!code || typeof code !== 'string') return false;
  if (code.length > MAX_CODE_LENGTH) return false;
  // Authorization codes are typically alphanumeric + URL-safe characters
  return /^[a-zA-Z0-9\-_\.~+/=]+$/.test(code);
}

/**
 * Forward OAuth code to the router for token exchange.
 */
async function forwardToRouter(provider, code, state) {
  const url = `${ROUTER_URL}/oauth/bridge/${encodeURIComponent(provider)}`;
  const body = { code };
  if (state) body.state = state;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-router-secret': ROUTER_SECRET,
    },
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
    // CORS: restrict to known origins (matching server.js pattern)
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
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

    // Reject early if ROUTER_SECRET is not configured
    if (!ROUTER_SECRET) {
      console.error(`[oauth] ${provider}: callback rejected — ROUTER_SECRET not configured`);
      res.writeHead(503, { 'Content-Type': 'text/html' });
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

    // Validate state parameter (defense-in-depth, router does authoritative check)
    if (!isValidState(state)) {
      console.error(`[oauth] Callback for ${provider} rejected: invalid or missing state`);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML);
      return;
    }

    // Forward to router
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

console.log('[oauth] OAuth callback listeners started');

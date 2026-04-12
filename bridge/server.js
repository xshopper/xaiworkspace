#!/usr/bin/env node
/**
 * Bridge pairing server (multi-router) — serves health check, pairing redirect,
 * and router management API on port 3100.
 *
 * On startup:
 * 1. Registers with each router in ROUTER_URLS via POST /api/bridges/register
 * 2. Writes credentials to /data/routers.json
 * 3. Serves http://localhost:3100 → router management page
 * 4. Serves http://localhost:3100/health → 200 OK
 * 5. Prints pairing codes to stdout
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const compose = require('./compose-manager');

const ROUTERS_FILE = '/data/routers.json';

/** Timing-safe secret comparison to prevent timing side-channel attacks. */
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ROUTER_URLS: comma-separated list of router base URLs
const ROUTER_URLS_RAW = process.env.ROUTER_URLS || process.env.ROUTER_URL || '';
const INITIAL_ROUTER_URLS = ROUTER_URLS_RAW.split(',').map(u => u.trim()).filter(Boolean);
if (INITIAL_ROUTER_URLS.length === 0) {
  console.error('[config] FATAL: ROUTER_URLS env var is required');
  process.exit(1);
}

// Read router secret from env var first, then fall back to Docker secret file.
const SECRETS_FILE_PATH = '/run/secrets/router_secret';
const ROUTER_SECRET = process.env.ROUTER_SECRET
  || (() => {
    try { return fs.readFileSync(SECRETS_FILE_PATH, 'utf8').trim(); }
    catch { return ''; }
  })();
if (!ROUTER_SECRET) {
  console.warn('[config] WARNING: ROUTER_SECRET not set (checked env var and /run/secrets/router_secret)');
}

const BRIDGE_VERSION = require('./package.json').version;
let HOST_OS = 'linux'; // resolved at startup via detectHostOs()
const PORT = parseInt(process.env.PAIRING_PORT || '3100', 10);
const APP_URL = process.env.APP_URL || 'https://xaiworkspace.com';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL || '30000', 10);

// PAIRING_CODE: short-lived code (5-min TTL) from a user-facing "add bridge"
// flow. When set, the bridge claims credentials via /api/bridges/claim-device
// instead of /api/bridges/register (which requires ROUTER_SECRET).
const PAIRING_CODE = process.env.PAIRING_CODE || '';

// Domain allowlist for adding new routers
const ALLOWED_ROUTER_DOMAINS = ['.xaiworkspace.com', '.xshopper.com', 'localhost'];

/** Validate a router URL against the domain allowlist. */
function isAllowedRouterUrl(routerUrl) {
  try {
    const { hostname } = new URL(routerUrl);
    return ALLOWED_ROUTER_DOMAINS.some(d =>
      d.startsWith('.') ? hostname.endsWith(d) || hostname === d.slice(1) : hostname === d
    );
  } catch { return false; }
}

/** Detect host OS via Docker API (container always reports linux). */
async function detectHostOs() {
  try {
    const resp = await new Promise((resolve) => {
      const req = http.request({ socketPath: '/var/run/docker.sock', path: '/info', method: 'GET' }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!resp?.OSType) return 'linux';
    const os = resp.OperatingSystem || '';
    if (os.includes('Docker Desktop')) {
      const kernel = resp.KernelVersion || '';
      if (kernel.includes('WSL')) return 'windows';
      if (kernel.includes('linuxkit')) return 'mac';
    }
    return resp.OSType === 'windows' ? 'windows' : 'linux';
  } catch { return 'linux'; }
}

// ── Routers file management ──────────────────────────────────────────────

function loadRouters() {
  try { return JSON.parse(fs.readFileSync(ROUTERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveRouters(routers) {
  const tmp = ROUTERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(routers, null, 2));
  fs.renameSync(tmp, ROUTERS_FILE);
}

/** Check if any known bridge token matches. */
function hasValidBridgeToken(headerToken) {
  if (!headerToken) return false;
  const routers = loadRouters();
  return routers.some(r => safeCompare(headerToken, r.bridgeToken));
}

// ── Docker API helpers ───────────────────────────────────────────────────

function dockerApiGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function dockerApiPost(path, jsonBody) {
  return new Promise((resolve) => {
    const body = jsonBody ? JSON.stringify(jsonBody) : '';
    const headers = jsonBody
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      : {};
    const req = http.request({
      socketPath: '/var/run/docker.sock', path, method: 'POST', headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end(body);
  });
}

function dockerApiDelete(path) {
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock', path, method: 'DELETE',
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
}

// Ports required for pairing redirect (OAuth moved to workspace CLIProxyAPI)
const BRIDGE_PORTS = [
  { container: 3100, host: 3100 },
];

async function needsPortBindings() {
  const hostname = require('os').hostname();
  const inspect = await dockerApiGet(`/containers/${hostname}/json`);
  if (!inspect) return false;
  if (!inspect.HostConfig?.PortBindings) return true;
  const bindings = inspect.HostConfig.PortBindings['3100/tcp'];
  return !bindings || bindings.length === 0;
}

/**
 * Re-create this container with host port bindings.
 * Uses credentials from the first router for the container env.
 */
async function recreateWithPorts() {
  const hostname = require('os').hostname();
  const inspect = await dockerApiGet(`/containers/${hostname}/json`);
  if (!inspect) {
    console.error('[bridge] Cannot inspect self — continuing without ports');
    return false;
  }

  console.log('[bridge] Becoming primary — re-creating with port bindings...');

  const portBindings = {};
  const exposedPorts = {};
  for (const p of BRIDGE_PORTS) {
    const key = `${p.container}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(p.host) }];
  }

  // Build env: copy original env but replace router config.
  // Remove old single-router vars, add ROUTER_URLS.
  const routers = loadRouters();
  const routerUrls = routers.map(r => r.routerUrl).join(',');
  const env = (inspect.Config.Env || [])
    .filter(e => !e.startsWith('PAIRING_CODE=') && !e.startsWith('BRIDGE_ID=')
      && !e.startsWith('BRIDGE_TOKEN=') && !e.startsWith('ROUTER_URL=')
      && !e.startsWith('ROUTER_URLS='));
  env.push(`ROUTER_URLS=${routerUrls}`);

  // Use first router's bridge ID for the container name
  const bridgeId = routers[0]?.bridgeId || `xaiw-bridge-${crypto.randomBytes(4).toString('hex')}`;

  const createBody = {
    Image: inspect.Config.Image,
    Env: env,
    ExposedPorts: { ...inspect.Config.ExposedPorts, ...exposedPorts },
    HostConfig: {
      ...inspect.HostConfig,
      AutoRemove: false,
      PortBindings: portBindings,
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: inspect.HostConfig.Binds,
    },
    Healthcheck: inspect.Config.Healthcheck,
  };

  const newName = `${bridgeId}-ported`;
  await dockerApiDelete(`/containers/${encodeURIComponent(newName)}?force=true`);

  const createResp = await dockerApiPost(
    `/containers/create?name=${encodeURIComponent(newName)}`,
    createBody,
  );

  if (createResp.status !== 201 || !createResp.body?.Id) {
    const errMsg = createResp.body?.message || '';
    if (/port is already allocated|address already in use/i.test(errMsg)) {
      console.warn(`[bridge] Host port conflict: ${errMsg}`);
    } else {
      console.error(`[bridge] Failed to create ported container: ${createResp.status} ${errMsg}`);
    }
    return false;
  }

  const newId = createResp.body.Id;
  await dockerApiPost(`/containers/${newId}/start`);

  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  New bridge created!');
  console.log(`  Ports: ${BRIDGE_PORTS.map(p => p.host).join(', ')}`);
  console.log(`  Container: ${newId.slice(0, 12)}`);
  console.log(`  Routers: ${routers.length}`);
  console.log('  Bridge is running in the background.');
  console.log('══════════════════════════════════════');
  console.log('');

  execFile('pm2', ['kill'], { timeout: 10000 }, () => process.exit(0));
}

// ── Router registration ──────────────────────────────────────────────────

/**
 * Exchange a pairing code for bridge credentials (user-pairing flow).
 * Used when PAIRING_CODE env var is set (e.g. from the frontend's "Add bridge"
 * docker-run command). The pairing code IS the auth — no ROUTER_SECRET needed.
 * Returns { routerUrl, bridgeId, bridgeToken, pairingCode } or null.
 */
async function claimDeviceWithCode(routerUrl) {
  try {
    const url = new URL('/api/bridges/claim-device', routerUrl);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: PAIRING_CODE,
        osType: HOST_OS,
        version: BRIDGE_VERSION,
      }),
    });

    if (resp.status === 410) {
      console.error(`[pairing] Pairing code has expired for ${routerUrl}. Generate a new one from the app.`);
      return null;
    }
    if (resp.status === 404) {
      console.error(`[pairing] Invalid pairing code for ${routerUrl}. Check the code and try again.`);
      return null;
    }
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[pairing] Claim failed for ${routerUrl}: ${resp.status} ${err}`);
      return null;
    }

    const data = await resp.json();
    return {
      routerUrl,
      bridgeId: data.bridgeId,
      bridgeToken: data.bridgeToken,
      pairingCode: data.pairingCode,
    };
  } catch (err) {
    console.error(`[pairing] Failed to claim with ${routerUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Register with a single router. Returns { routerUrl, bridgeId, bridgeToken, pairingCode } or null.
 */
async function registerWithRouter(routerUrl) {
  try {
    const url = new URL('/api/bridges/register', routerUrl);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-router-secret': ROUTER_SECRET,
      },
      body: JSON.stringify({
        port: PORT,
        region: process.env.REGION || 'local',
        provider: process.env.PROVIDER || 'local',
        version: BRIDGE_VERSION,
        osType: HOST_OS,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[pairing] Register failed for ${routerUrl}: ${resp.status} ${err}`);
      return null;
    }

    const data = await resp.json();
    return {
      routerUrl,
      bridgeId: data.bridgeId,
      bridgeToken: data.bridgeToken,
      pairingCode: data.pairingCode,
    };
  } catch (err) {
    console.error(`[pairing] Failed to register with ${routerUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Register with all initial routers. Retries failed ones.
 */
async function registerAllRouters() {
  const routers = loadRouters();
  const existingUrls = new Set(routers.map(r => r.routerUrl));

  const toRegister = INITIAL_ROUTER_URLS.filter(url => !existingUrls.has(url));
  if (toRegister.length === 0 && routers.length > 0) {
    console.log(`[pairing] All ${routers.length} router(s) already registered`);
    printStatus(routers);
    return;
  }

  // Pick credential-acquisition method: PAIRING_CODE (user pairing, no router
  // secret needed) or ROUTER_SECRET-authenticated register (privileged bridges).
  const acquire = PAIRING_CODE ? claimDeviceWithCode : registerWithRouter;
  const verb = PAIRING_CODE ? 'Claiming with' : 'Registering with';
  console.log(`[pairing] ${verb} ${toRegister.length} new router(s) concurrently...`);

  async function registerWithRetries(routerUrl) {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await acquire(routerUrl);
      if (result) return result;
      const delay = Math.min(5000 * attempt, 30000);
      console.log(`[pairing] Retry ${attempt}/10 for ${routerUrl} in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
    console.error(`[pairing] Failed to ${PAIRING_CODE ? 'claim' : 'register'} with ${routerUrl} after 10 attempts`);
    return null;
  }

  const results = await Promise.allSettled(toRegister.map(url => registerWithRetries(url)));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      routers.push(r.value);
      console.log(`[pairing] Registered with ${r.value.routerUrl}: bridge=${r.value.bridgeId}`);
    }
  }

  saveRouters(routers);
  printStatus(routers);
}

function printStatus(routers) {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log(`  xAI Workspace Bridge v${BRIDGE_VERSION}`);
  console.log(`  Connected to ${routers.length} router(s):`);
  for (const r of routers) {
    console.log(`    ${r.routerUrl} (${r.bridgeId})`);
    if (r.pairingCode) {
      console.log(`      Code: ${r.pairingCode}`);
    }
  }
  console.log('══════════════════════════════════════');
  console.log('');
}

// ── Parse JSON body ──────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// ── Router management web UI HTML ────────────────────────────────────────

/** Escape HTML to prevent XSS from router-supplied values. */
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function routerManagementPage() {
  const routers = loadRouters();
  const routerRows = routers.map(r => `
    <tr>
      <td>${esc(r.routerUrl)}</td>
      <td><button data-url="${esc(r.routerUrl)}" class="btn-remove">Remove</button></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><title>Bridge Router Management</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e5e5e5; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
  th { color: #999; font-size: 12px; text-transform: uppercase; }
  input { background: #1a1a1a; border: 1px solid #333; color: #e5e5e5; padding: 8px 12px; border-radius: 6px; width: 300px; }
  button { background: #3b82f6; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #2563eb; }
  button.danger { background: #dc3545; }
  button.danger:hover { background: #b02a37; }
  .status { padding: 8px; border-radius: 6px; margin-top: 8px; display: none; }
  .status.error { background: #3b1a1a; color: #f87171; display: block; }
  .status.ok { background: #1a3b1a; color: #4ade80; display: block; }
</style></head>
<body>
  <h1>Bridge Router Management</h1>
  <table>
    <tr><th>Router URL</th><th></th></tr>
    ${routerRows || '<tr><td colspan="2" style="color:#666">No routers connected</td></tr>'}
  </table>
  <h2 style="font-size:16px">Add Router</h2>
  <form onsubmit="addRouter(event)">
    <input id="url" placeholder="https://router.xaiworkspace.com" required>
    <button type="submit">Add</button>
  </form>
  <div id="status" class="status"></div>
  <script>
    async function addRouter(e) {
      e.preventDefault();
      const url = document.getElementById('url').value.trim();
      const s = document.getElementById('status');
      s.className = 'status'; s.textContent = '';
      try {
        const r = await fetch('/api/routers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({routerUrl:url}) });
        const d = await r.json();
        if (r.ok) { s.className = 'status ok'; s.textContent = 'Added successfully'; setTimeout(() => location.reload(), 1000); }
        else { s.className = 'status error'; s.textContent = d.error || 'Failed'; }
      } catch(err) { s.className = 'status error'; s.textContent = err.message; }
    }
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-remove');
      if (!btn) return;
      const url = btn.dataset.url;
      if (!confirm('Remove ' + url + '?')) return;
      await fetch('/api/routers', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({routerUrl:url}) });
      location.reload();
    });
  </script>
</body></html>`;
}

// ── HTTP Server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-router-secret, x-bridge-token');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Health check ────────────────────────────────────────────────────
  if (req.url === '/health') {
    const routers = loadRouters();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routers: routers.length }));
    return;
  }

  // ── Router management API ───────────────────────────────────────────

  if (req.url === '/api/routers' && req.method === 'GET') {
    const routers = loadRouters();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Return non-sensitive fields only (no tokens, no pairing codes)
    res.end(JSON.stringify(routers.map(r => ({
      routerUrl: r.routerUrl,
    }))));
    return;
  }

  if (req.url === '/api/routers' && req.method === 'POST') {
    // Auth: require ROUTER_SECRET or any valid bridge token
    const hasSecret = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasToken = hasValidBridgeToken(req.headers['x-bridge-token']);
    // Also allow unauthenticated requests from the web UI (same-origin localhost)
    const isLocalhost = /^(127\.|::1|::ffff:127\.)/.test(req.socket?.remoteAddress || '');
    if (!hasSecret && !hasToken && !isLocalhost) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const body = await parseBody(req);
    const { routerUrl } = body;

    if (!routerUrl || typeof routerUrl !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'routerUrl required' }));
      return;
    }

    if (!isAllowedRouterUrl(routerUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Router URL not in allowed domains' }));
      return;
    }

    const routers = loadRouters();
    if (routers.some(r => r.routerUrl === routerUrl)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Router already registered' }));
      return;
    }

    const result = await registerWithRouter(routerUrl);
    if (!result) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to register with router' }));
      return;
    }

    routers.push(result);
    saveRouters(routers);
    console.log(`[api] Added router: ${routerUrl} (${result.bridgeId})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routerUrl, bridgeId: result.bridgeId }));
    return;
  }

  if (req.url === '/api/routers' && req.method === 'DELETE') {
    // Same auth as POST
    const hasSecretDel = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasTokenDel = hasValidBridgeToken(req.headers['x-bridge-token']);
    const isLocalhostDel = /^(127\.|::1|::ffff:127\.)/.test(req.socket?.remoteAddress || '');
    if (!hasSecretDel && !hasTokenDel && !isLocalhostDel) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const body = await parseBody(req);
    const { routerUrl } = body;

    if (!routerUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'routerUrl required' }));
      return;
    }

    const routers = loadRouters();
    const filtered = routers.filter(r => r.routerUrl !== routerUrl);
    if (filtered.length === routers.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Router not found' }));
      return;
    }

    saveRouters(filtered);
    console.log(`[api] Removed router: ${routerUrl}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Compose stack management API ────────────────────────────────────

  if (req.url === '/api/instances' && req.method === 'GET') {
    const instances = compose.listInstances();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ instances }));
    return;
  }

  if (req.url === '/api/instances' && req.method === 'POST') {
    const hasSecret = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasToken = hasValidBridgeToken(req.headers['x-bridge-token']);
    if (!hasSecret && !hasToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const body = await parseBody(req);
    if (!body.instanceId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing instanceId' }));
      return;
    }
    try {
      compose.addInstance(body.instanceId, {
        image: body.image,
        env: body.env || {},
        ports: body.ports || [],
        volumes: body.volumes || [],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instanceId: body.instanceId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/instances/') && req.url.endsWith('/health') && req.method === 'GET') {
    const parts = req.url.split('/');
    const instanceId = decodeURIComponent(parts[3]);
    if (!/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid instanceId' }));
      return;
    }
    const instances = compose.listInstances();
    const inst = instances.find(i => i.name === instanceId);
    res.writeHead(inst ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!inst, status: inst?.status }));
    return;
  }

  if (req.url?.startsWith('/api/instances/') && req.method === 'DELETE') {
    const hasSecret = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasToken = hasValidBridgeToken(req.headers['x-bridge-token']);
    if (!hasSecret && !hasToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const instanceId = decodeURIComponent(req.url.split('/api/instances/')[1]);
    if (instanceId.startsWith('xaiw-bridge')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot remove the bridge' }));
      return;
    }
    try {
      const removed = compose.removeInstance(instanceId);
      res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: removed }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Default: router management page ─────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(routerManagementPage());
});

// ── Compose stack scanner ─────────────────────────────────────────────────

const knownInstances = new Set();

/** Report a dead instance to all routers. */
async function reportInstanceGone(instanceId) {
  const routers = loadRouters();
  for (const r of routers) {
    try {
      const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/gone`, r.routerUrl);
      await fetch(url.toString(), {
        method: 'POST',
        headers: { 'x-bridge-token': r.bridgeToken, 'x-bridge-id': r.bridgeId },
      });
    } catch { /* best effort */ }
  }
  console.log(`[scanner] Reported instance gone: ${instanceId}`);
}

/** Report container status to all routers. */
async function reportInstanceStatus(instanceId, status) {
  const routers = loadRouters();
  for (const r of routers) {
    try {
      const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/status`, r.routerUrl);
      await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-token': r.bridgeToken,
          'x-bridge-id': r.bridgeId,
        },
        body: JSON.stringify({ status, bridgeId: r.bridgeId }),
      });
    } catch { /* best effort */ }
  }
}

async function scanStack() {
  const instances = compose.listInstances();
  const currentNames = new Set(instances.map(i => i.name));

  for (const name of knownInstances) {
    if (!currentNames.has(name)) {
      console.log(`[scanner] Instance ${name} disappeared from stack`);
      await reportInstanceGone(name);
      knownInstances.delete(name);
    }
  }

  for (const inst of instances) {
    if (!knownInstances.has(inst.name)) {
      knownInstances.add(inst.name);
      console.log(`[scanner] Tracking: ${inst.name} (${inst.status})`);
    }
    const status = inst.status === 'running' ? 'active' : inst.status === 'exited' ? 'stopped' : inst.status;
    await reportInstanceStatus(inst.name, status);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  HOST_OS = await detectHostOs();
  console.log(`[pairing] Bridge v${BRIDGE_VERSION} listening on port ${PORT} (host: ${HOST_OS})`);

  // Register with all routers
  await registerAllRouters();

  // Watch for bridge_primary signal from bridge.js
  let recreating = false;
  const primaryCheckInterval = setInterval(async () => {
    if (recreating) return;
    if (!fs.existsSync('/data/bridge_primary')) return;
    if (await needsPortBindings()) {
      console.log('[bridge] Router confirmed primary — recreating with port bindings...');
      recreating = true;
      const ok = await recreateWithPorts();
      recreating = false;
      if (ok !== false) {
        try { fs.unlinkSync('/data/bridge_primary'); } catch {}
        return;
      }
      console.log('[bridge] Port binding failed, will retry');
    } else {
      try { fs.unlinkSync('/data/bridge_primary'); } catch {}
      clearInterval(primaryCheckInterval);
    }
  }, 1000);

  // Start compose stack scanning
  setTimeout(() => {
    scanStack();
    setInterval(scanStack, SCAN_INTERVAL_MS);
    console.log(`[scanner] Compose stack scanning started (every ${SCAN_INTERVAL_MS / 1000}s)`);
  }, 5000);
});

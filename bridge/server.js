#!/usr/bin/env node
/**
 * Bridge pairing server — serves health check and pairing redirect on port 3100.
 *
 * On startup:
 * 1. Resolves credentials via POST /api/bridges/claim-device
 * 2. Serves http://localhost:3100 → redirect to https://app.xaiworkspace.com/link?code=XXXX
 * 3. Serves http://localhost:3100/health → 200 OK
 * 4. Prints the pairing code + URL to stdout (for headless servers)
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const compose = require('./compose-manager');

/** Timing-safe secret comparison to prevent timing side-channel attacks. */
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const ROUTER_URL = process.env.ROUTER_URL;
if (!ROUTER_URL) {
  console.error('[config] FATAL: ROUTER_URL env var is required (prevents silent fallback to production)');
  process.exit(1);
}
// Read router secret from env var first, then fall back to Docker secret file.
// The Tauri app mounts the secret as a read-only file to avoid exposing it
// in `docker inspect` output (which shows all -e env vars in cleartext).
const SECRETS_FILE_PATH = '/run/secrets/router_secret';
const ROUTER_SECRET = process.env.ROUTER_SECRET
  || (() => {
    try { return fs.readFileSync(SECRETS_FILE_PATH, 'utf8').trim(); }
    catch { return ''; }
  })();
if (!ROUTER_SECRET) {
  console.warn('[config] WARNING: ROUTER_SECRET not set (checked env var and /run/secrets/router_secret)');
}
// BRIDGE_ID is the preferred name (from POST /api/bridges), INSTANCE_ID is the legacy fallback
let INSTANCE_ID = process.env.BRIDGE_ID || process.env.INSTANCE_ID || '';
// BRIDGE_TOKEN: permanent credential for WS auth (resolved from pairing code or set directly).
let BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
// PAIRING_CODE: short-lived code to claim credentials from the router (replaces BRIDGE_TOKEN in docker command).
const PAIRING_CODE = process.env.PAIRING_CODE || '';
const BRIDGE_VERSION = require('./package.json').version;
let HOST_OS = 'linux'; // resolved at startup via detectHostOs()

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
    // Docker Desktop on Mac/Windows reports OSType=linux but has "Docker Desktop" in Name
    const name = (resp.Name || '').toLowerCase();
    const os = resp.OperatingSystem || '';
    if (os.includes('Docker Desktop') || name.includes('docker-desktop')) {
      // Check kernel version for hints
      const kernel = resp.KernelVersion || '';
      if (kernel.includes('linuxkit') || kernel.includes('WSL')) {
        // linuxkit = macOS Docker Desktop, WSL = Windows Docker Desktop
        return kernel.includes('WSL') ? 'windows' : 'mac';
      }
    }
    return resp.OSType === 'windows' ? 'windows' : 'linux';
  } catch { return 'linux'; }
}
const PORT = parseInt(process.env.PAIRING_PORT || '3100', 10);
const APP_URL = process.env.APP_URL || 'https://xaiworkspace.com';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL || '30000', 10); // 30s

// ── Docker API helpers (via unix socket) ──────────────────────────────────
// Used for port re-creation when router instructs this bridge to become primary.

function dockerApiGet(path) {
  return new Promise((resolve) => {
    const options = { socketPath: '/var/run/docker.sock', path, method: 'GET' };
    const req = http.request(options, (res) => {
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

// Ports required for OAuth callbacks and pairing redirect
const BRIDGE_PORTS = [
  { container: 3100, host: 3100 },   // pairing server
  { container: 54545, host: 54545 }, // Claude OAuth
  { container: 8085, host: 8085 },   // Gemini OAuth
  { container: 1455, host: 1455 },   // Codex OAuth
];

/** Check if this container was started without host port bindings. */
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
 * Called when router sends bridge_primary and container has no ports.
 * Returns false on failure; on success the process is killed (never returns).
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

  // Build env: copy original env but inject resolved credentials.
  // Remove PAIRING_CODE (one-time use) and add BRIDGE_ID + BRIDGE_TOKEN (permanent).
  const env = (inspect.Config.Env || [])
    .filter(e => !e.startsWith('PAIRING_CODE=') && !e.startsWith('BRIDGE_ID=') && !e.startsWith('BRIDGE_TOKEN='));
  if (INSTANCE_ID) env.push(`BRIDGE_ID=${INSTANCE_ID}`);
  if (BRIDGE_TOKEN) env.push(`BRIDGE_TOKEN=${BRIDGE_TOKEN}`);

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

  // The initial container was started with --rm (no host port bindings).
  // We can create the new container first (no port conflict), then start it,
  // then stop self. Stopping a --rm container removes it immediately, so we
  // must NOT stop self before creating the replacement.
  const newName = `${INSTANCE_ID || 'xaiw-bridge'}-ported`;

  // Clean up stale container from a previous attempt
  await dockerApiDelete(`/containers/${encodeURIComponent(newName)}?force=true`);

  // Create new container with port bindings
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
  console.log('  Bridge is running in the background.');
  console.log('══════════════════════════════════════');
  console.log('');

  // Exit — the --rm flag on our container handles self-cleanup.
  // Use pm2 kill to stop all processes and let the container exit.
  const { execFile } = require('child_process');
  execFile('pm2', ['kill'], { timeout: 10000 }, () => process.exit(0));
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

/** Fetch non-sensitive config from router (app URL, etc). Never fetch secrets over unauthenticated endpoints. */
async function fetchRouterConfig() {
  try {
    const url = new URL('/api/config/desktop', ROUTER_URL);
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const cfg = await resp.json();
    // NOTE: routerSecret is intentionally NOT fetched here — it must be provided via
    // ROUTER_SECRET env var or the authenticated /api/config/provision endpoint.
    if (cfg.routerSecret) {
      console.warn('[config] Desktop config endpoint is exposing routerSecret — this should be removed from the router API');
    }
  } catch (err) {
    console.warn('[config] Failed to fetch router config:', err.message);
  }
}

let pairingCode = null;
let pairingUrl = null;
let registered = false;

/**
 * Pre-provisioned flow: bridge was created via POST /api/bridges (user-authenticated).
 * BRIDGE_TOKEN is already set — write auth.json and mark as registered.
 * The pairing code was already assigned server-side; we fetch it via the connect endpoint.
 */
async function setupPreProvisioned() {
  console.log(`[pairing] Pre-provisioned bridge: ${INSTANCE_ID}`);

  // Write credentials for bridge.js WS auth
  const authData = {
    type: 'gateway_auth',
    instanceId: INSTANCE_ID,
    instanceToken: BRIDGE_TOKEN,
  };
  fs.writeFileSync('/data/auth.json', JSON.stringify(authData));

  // Restart bridge process with updated credentials
  const { execSync } = require('child_process');
  try {
    execSync(`pm2 restart bridge --update-env`, {
      env: { ...process.env, AUTH_JSON: JSON.stringify(authData) },
      timeout: 10_000,
    });
    console.log('[pairing] Bridge process restarted with credentials');
  } catch (err) {
    console.warn('[pairing] Failed to restart bridge process:', err.message);
  }

  // Register with the router to get pairing code and confirm connectivity.
  // Uses BRIDGE_TOKEN as x-bridge-token for auth (not ROUTER_SECRET).
  try {
    const url = new URL('/api/bridges/register', ROUTER_URL);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        bridgeId: INSTANCE_ID,
        port: PORT,
        region: process.env.REGION || 'local',
        provider: process.env.PROVIDER || 'local',
        version: require('./package.json').version,
        osType: HOST_OS,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      pairingCode = data.pairingCode;
      pairingUrl = `${APP_URL}/link?code=${pairingCode}`;
    }
  } catch (err) {
    console.warn('[pairing] Failed to fetch pairing code:', err.message);
  }

  registered = true;
  console.log('');
  console.log('══════════════════════════════════════');
  console.log(`  xAI Workspace Bridge ready!`);
  if (pairingCode) {
    console.log('');
    console.log(`  Link: ${pairingUrl}`);
    console.log(`  Code: ${pairingCode}`);
    console.log('  Share this code with users to create workspaces.');
  }
  console.log('══════════════════════════════════════');
  console.log('');
}

/**
 * Self-registration flow: bridge registers with ROUTER_SECRET.
 * Used when bridge is started manually (not via POST /api/bridges).
 */
async function registerBridge() {
  try {
    const url = new URL('/api/bridges/register', ROUTER_URL);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-router-secret': ROUTER_SECRET,
      },
      body: JSON.stringify({
        bridgeId: INSTANCE_ID,
        port: PORT,
        region: process.env.REGION || 'local',
        provider: process.env.PROVIDER || 'local',
        version: require('./package.json').version,
        osType: HOST_OS,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[pairing] Bridge register failed: ${resp.status} ${err}`);
      return;
    }

    const data = await resp.json();
    pairingCode = data.pairingCode;
    pairingUrl = `${APP_URL}/link?code=${pairingCode}`;
    registered = true;

    // Write bridge credentials so bridge.js can authenticate with the router WS.
    if (data.bridgeToken) {
      const authData = {
        type: 'gateway_auth',
        instanceId: INSTANCE_ID,
        instanceToken: data.bridgeToken,
      };
      fs.writeFileSync('/data/auth.json', JSON.stringify(authData));
      // Restart bridge process with updated credentials
      const { execSync } = require('child_process');
      try {
        execSync(`pm2 restart bridge --update-env`, {
          env: { ...process.env, AUTH_JSON: JSON.stringify(authData) },
          timeout: 10_000,
        });
        console.log('[pairing] Bridge process restarted with credentials');
      } catch (err) {
        console.warn('[pairing] Failed to restart bridge process:', err.message);
      }
    }

    console.log('');
    console.log('══════════════════════════════════════');
    console.log(`  xAI Workspace Bridge ready! (${data.isNew ? 'new' : 'reconnect'})`);
    console.log('');
    console.log(`  Link: ${pairingUrl}`);
    console.log(`  Code: ${pairingCode}`);
    console.log('  Share this code with users to create workspaces.');
    console.log('══════════════════════════════════════');
    console.log('');
  } catch (err) {
    console.error('[pairing] Failed to register:', err.message);
  }
}

/** Parse JSON body from request. */
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = () => {
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-router-secret, x-bridge-token');
  };
  cors();

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, registered, pairingCode: !!pairingCode }));
    return;
  }

  if (req.url === '/pairing-code') {
    // Accept x-router-secret OR x-bridge-token (Tauri reuse path uses bridge token)
    const hasRouterSecret = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasBridgeToken = BRIDGE_TOKEN && safeCompare(req.headers['x-bridge-token'], BRIDGE_TOKEN);
    if (!hasRouterSecret && !hasBridgeToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: pairingCode, url: pairingUrl, registered }));
    return;
  }

  // ── Compose stack management API ──────────────────────────────────────

  if (req.url === '/api/instances' && req.method === 'GET') {
    const instances = compose.listInstances();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ instances }));
    return;
  }

  if (req.url === '/api/instances' && req.method === 'POST') {
    // Auth: router can provision instances using either ROUTER_SECRET or BRIDGE_TOKEN.
    // The provisioner sends x-bridge-token (per-bridge secret from DB).
    // Legacy / local deployments may send x-router-secret.
    const hasRouterSecret = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasBridgeToken = BRIDGE_TOKEN && safeCompare(req.headers['x-bridge-token'], BRIDGE_TOKEN);
    if (!hasRouterSecret && !hasBridgeToken) {
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

  if (req.url?.startsWith('/api/instances/') && req.method === 'DELETE') {
    const hasRouterSecretDel = ROUTER_SECRET && safeCompare(req.headers['x-router-secret'], ROUTER_SECRET);
    const hasBridgeTokenDel = BRIDGE_TOKEN && safeCompare(req.headers['x-bridge-token'], BRIDGE_TOKEN);
    if (!hasRouterSecretDel && !hasBridgeTokenDel) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const instanceId = decodeURIComponent(req.url.split('/api/instances/')[1]);
    if (instanceId === INSTANCE_ID || instanceId.startsWith('xaiw-bridge')) {
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

  // Default: redirect to pairing URL, app URL (if claimed), or show waiting page
  if (pairingUrl) {
    res.writeHead(302, { Location: pairingUrl });
    res.end();
  } else if (registered) {
    // Already claimed — redirect to the app directly
    res.writeHead(302, { Location: APP_URL });
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f;color:#e5e5e5}
      .s{width:24px;height:24px;border:3px solid rgba(255,255,255,0.2);border-top-color:#3b82f6;border-radius:50%;animation:s .8s linear infinite}
      @keyframes s{to{transform:rotate(360deg)}}</style></head>
      <body><div style="text-align:center"><div class="s" style="margin:0 auto 16px"></div><p>Connecting to router...</p></div></body></html>`);
  }
});

// ── Compose stack scanner ───────────────────────────────────────────────────
// Periodically checks the compose stack and reports status to the router.
// If a managed container disappears, the router is notified.

const knownInstances = new Set();

/** Auth headers for bridge→router API calls. Prefer BRIDGE_TOKEN, fall back to ROUTER_SECRET. */
function bridgeAuthHeaders() {
  if (BRIDGE_TOKEN) {
    return { 'x-bridge-token': BRIDGE_TOKEN, 'x-bridge-id': INSTANCE_ID };
  }
  return { 'x-router-secret': ROUTER_SECRET };
}

/** Report a dead instance to the router. */
async function reportInstanceGone(instanceId) {
  try {
    const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/gone`, ROUTER_URL);
    await fetch(url.toString(), { method: 'POST', headers: bridgeAuthHeaders() });
    console.log(`[scanner] Reported instance gone: ${instanceId}`);
  } catch (err) {
    console.warn(`[scanner] Failed to report gone ${instanceId}: ${err.message}`);
  }
}

/** Report container status to the router (also links instance to this bridge). */
async function reportInstanceStatus(instanceId, status) {
  try {
    const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/status`, ROUTER_URL);
    await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeAuthHeaders() },
      body: JSON.stringify({ status, bridgeId: INSTANCE_ID }),
    });
  } catch { /* best effort */ }
}

async function scanStack() {
  const instances = compose.listInstances();
  const currentNames = new Set(instances.map(i => i.name));

  // Check for instances that disappeared
  for (const name of knownInstances) {
    if (!currentNames.has(name)) {
      console.log(`[scanner] Instance ${name} disappeared from stack`);
      await reportInstanceGone(name);
      knownInstances.delete(name);
    }
  }

  // Track and report current instances
  for (const inst of instances) {
    if (!knownInstances.has(inst.name)) {
      knownInstances.add(inst.name);
      console.log(`[scanner] Tracking: ${inst.name} (${inst.status})`);
    }
    const status = inst.status === 'running' ? 'active' : inst.status === 'exited' ? 'stopped' : inst.status;
    await reportInstanceStatus(inst.name, status);
  }
}

/** Retry registration until successful (router may not be ready on first boot).
 *  After exhausting retries, enters a slow-poll mode (every 5 min) instead of giving up. */
async function registerWithRetry(maxRetries = 20, initialDelayMs = 5000) {
  const maxDelayMs = 60000;
  let delayMs = initialDelayMs;
  let consecutiveNetworkErrors = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await registerBridge();
    if (registered) {
      console.log(`[pairing] Registered successfully on attempt ${attempt}`);
      return;
    }

    consecutiveNetworkErrors++;
    // If we get 5+ consecutive failures with same delay ceiling, the router is likely
    // unreachable (wrong URL, DNS failure) — warn loudly
    if (consecutiveNetworkErrors >= 5 && delayMs >= maxDelayMs) {
      console.error(`[pairing] Router appears unreachable after ${consecutiveNetworkErrors} consecutive failures — check ROUTER_URL (${ROUTER_URL})`);
    }

    console.log(`[pairing] Registration attempt ${attempt}/${maxRetries} failed — retrying in ${delayMs / 1000}s`);
    await new Promise(r => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }

  console.error(`[pairing] Exhausted ${maxRetries} fast retries — entering slow-poll mode (every 5 min)`);

  // Slow-poll: keep trying indefinitely at 5-minute intervals
  const slowPollMs = 300000;
  const slowPoll = async () => {
    if (registered) return;
    await registerBridge();
    if (registered) {
      console.log('[pairing] Registered successfully via slow-poll');
      return;
    }
    setTimeout(slowPoll, slowPollMs);
  };
  setTimeout(slowPoll, slowPollMs);
}

server.listen(PORT, '0.0.0.0', async () => {
  HOST_OS = await detectHostOs();
  console.log(`[pairing] Bridge v${BRIDGE_VERSION} listening on port ${PORT} (host: ${HOST_OS})`);

  // ── Pairing code resolution ──────────────────────────────────────────
  // If started with PAIRING_CODE (from docker command), resolve credentials from router.
  if (PAIRING_CODE && !BRIDGE_TOKEN) {
    const osType = HOST_OS;
    let resolved = false;
    for (let attempt = 1; attempt <= 10 && !resolved; attempt++) {
      console.log(`[pairing] Resolving credentials from pairing code ${PAIRING_CODE}... (attempt ${attempt})`);
      try {
        const url = new URL('/api/bridges/claim-device', ROUTER_URL);
        const resp = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: PAIRING_CODE, osType, version: BRIDGE_VERSION }),
        });
        if (resp.status === 429) {
          console.warn('[pairing] Rate limited — retrying in 5s...');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        if (resp.status === 410) {
          console.error('[pairing] Pairing code has expired. Generate a new one from the app.');
          process.exit(1);
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }));
          console.error(`[pairing] Failed to resolve pairing code: ${err.error}`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        const data = await resp.json();
        INSTANCE_ID = data.bridgeId;
        BRIDGE_TOKEN = data.bridgeToken;
        resolved = true;
        console.log(`[pairing] Resolved: bridge=${INSTANCE_ID}`);
      } catch (err) {
        console.error(`[pairing] Failed to contact router: ${err.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!resolved) {
      console.error('[pairing] Could not resolve pairing code after 10 attempts.');
      process.exit(1);
    }
  }

  // Generate a random ID if none resolved
  if (!INSTANCE_ID) {
    INSTANCE_ID = `xaiw-bridge-${crypto.randomBytes(8).toString('hex')}`;
  }

  if (BRIDGE_TOKEN) {
    // Pre-provisioned: bridge was created via POST /api/bridges with user auth
    await setupPreProvisioned();

    // Watch for bridge_primary signal from bridge.js (router instructed us to become primary)
    // If we have no host ports, recreate with ports in the background
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
          // Success — delete signal file, new container is running
          try { fs.unlinkSync('/data/bridge_primary'); } catch {}
          return;
        }
        // Recreation failed — keep signal file so interval retries
        console.log('[bridge] Port binding failed, will retry');
      } else {
        try { fs.unlinkSync('/data/bridge_primary'); } catch {}
        clearInterval(primaryCheckInterval); // already has ports, stop checking
      }
    }, 1000);
  } else {
    // Self-registration: bridge registers with ROUTER_SECRET
    fetchRouterConfig().then(() => registerWithRetry());
  }

  // Start compose stack scanning after a short delay
  setTimeout(() => {
    scanStack();
    setInterval(scanStack, SCAN_INTERVAL_MS);
    console.log(`[scanner] Compose stack scanning started (every ${SCAN_INTERVAL_MS / 1000}s)`);
  }, 5000);
});

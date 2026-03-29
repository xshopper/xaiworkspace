#!/usr/bin/env node
/**
 * Bridge pairing server — serves health check and pairing redirect on port 3100.
 *
 * On startup:
 * 1. Calls POST /api/instances/register-pending on the router to get a pairing code
 * 2. Serves http://localhost:3100 → redirect to https://app.xaiworkspace.com/link?code=XXXX
 * 3. Serves http://localhost:3100/health → 200 OK
 * 4. Prints the pairing code + URL to stdout (for headless servers)
 */
const http = require('http');
const { execFile } = require('child_process');
const compose = require('./compose-manager');

const ROUTER_URL = process.env.ROUTER_URL || 'https://router.xaiworkspace.com';
let ROUTER_SECRET = process.env.ROUTER_SECRET || '';
const INSTANCE_ID = process.env.INSTANCE_ID || `xaiw-bridge-${require('crypto').randomBytes(8).toString('hex')}`;
const PORT = parseInt(process.env.PAIRING_PORT || '3100', 10);
let APP_URL = process.env.APP_URL || 'https://xaiworkspace.com';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL || '30000', 10); // 30s

/** Fetch config from router (includes routerSecret). */
async function fetchRouterConfig() {
  try {
    const url = new URL('/api/config/desktop', ROUTER_URL);
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const cfg = await resp.json();
    if (cfg.routerSecret && !ROUTER_SECRET) {
      ROUTER_SECRET = cfg.routerSecret;
      console.log('[config] Fetched router secret from config endpoint');
    }
    if (cfg.appUrl && APP_URL === 'https://xaiworkspace.com') {
      APP_URL = cfg.appUrl;
    }
  } catch (err) {
    console.warn('[config] Failed to fetch router config:', err.message);
  }
}

let pairingCode = null;
let pairingUrl = null;
let registered = false;

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
        region: 'local',
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
      const fs = require('fs');
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
  const cors = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-router-secret');
  };
  cors();

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, registered, pairingCode: !!pairingCode }));
    return;
  }

  if (req.url === '/pairing-code') {
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
    // Auth: only the router can add/remove instances
    if (req.headers['x-router-secret'] !== ROUTER_SECRET) {
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
    if (req.headers['x-router-secret'] !== ROUTER_SECRET) {
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

/** Report a dead instance to the router. */
async function reportInstanceGone(instanceId) {
  try {
    const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/gone`, ROUTER_URL);
    await fetch(url.toString(), { method: 'POST', headers: { 'x-router-secret': ROUTER_SECRET } });
    console.log(`[scanner] Reported instance gone: ${instanceId}`);
  } catch (err) {
    console.warn(`[scanner] Failed to report gone ${instanceId}: ${err.message}`);
  }
}

/** Report container status to the router. */
async function reportInstanceStatus(instanceId, status) {
  try {
    const url = new URL(`/api/instances/${encodeURIComponent(instanceId)}/status`, ROUTER_URL);
    await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-router-secret': ROUTER_SECRET },
      body: JSON.stringify({ status }),
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

/** Retry registration until successful (router may not be ready on first boot). */
async function registerWithRetry(maxRetries = 30, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await registerBridge();
    if (registered) return;
    console.log(`[pairing] Registration attempt ${attempt}/${maxRetries} failed — retrying in ${delayMs / 1000}s`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  console.error('[pairing] Exhausted registration retries');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pairing] Listening on port ${PORT}`);
  // Fetch router config (includes secret) before registering
  fetchRouterConfig().then(() => registerWithRetry());

  // Start compose stack scanning after a short delay
  setTimeout(() => {
    scanStack();
    setInterval(scanStack, SCAN_INTERVAL_MS);
    console.log(`[scanner] Compose stack scanning started (every ${SCAN_INTERVAL_MS / 1000}s)`);
  }, 5000);
});

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

const ROUTER_URL = process.env.ROUTER_URL || 'https://router.xaiworkspace.com';
const ROUTER_SECRET = process.env.ROUTER_SECRET || '';
const INSTANCE_ID = process.env.INSTANCE_ID || `bridge-${require('crypto').randomBytes(8).toString('hex')}`;
const PORT = parseInt(process.env.PAIRING_PORT || '3100', 10);
const APP_URL = process.env.APP_URL || 'https://app.xaiworkspace.com';

let pairingCode = null;
let pairingUrl = null;
let registered = false;

async function registerPending() {
  try {
    const body = JSON.stringify({
      instanceId: INSTANCE_ID,
      port: PORT,
      region: 'local',
    });

    const url = new URL('/api/instances/register-pending', ROUTER_URL);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-router-secret': ROUTER_SECRET,
      },
      body,
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[pairing] register-pending failed: ${resp.status} ${err}`);
      return;
    }

    const data = await resp.json();
    pairingCode = data.code;
    pairingUrl = `${APP_URL}/link?code=${pairingCode}`;
    registered = true;

    console.log('');
    console.log('══════════════════════════════════════');
    console.log('  xAI Workspace Bridge ready!');
    console.log('');
    console.log(`  Link: ${pairingUrl}`);
    console.log(`  Code: ${pairingCode}`);
    console.log('══════════════════════════════════════');
    console.log('');
  } catch (err) {
    console.error('[pairing] Failed to register:', err.message);
  }
}

const server = http.createServer((req, res) => {
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

  // Default: redirect to pairing URL or show waiting page
  if (pairingUrl) {
    res.writeHead(302, { Location: pairingUrl });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pairing] Listening on port ${PORT}`);
  registerPending();
});

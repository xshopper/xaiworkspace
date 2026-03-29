#!/usr/bin/env node
// ─── WS Bridge: router ↔ local OpenClaw gateway ────────────────────────────
// Connects to the router via reverse WebSocket, authenticates with instanceToken,
// then bridges messages to the local OpenClaw gateway via JSON-RPC handshake.
//
// All traffic goes through the tunnel — no direct IP connections.
//
// Environment variables:
//   ROUTER_WS      — wss://router/ws/gateway
//   LOCAL_PORT     — local gateway port (default: 19001)
//   AUTH_JSON      — JSON string: { type, instanceId, instanceToken, chatId, port }
//   GW_PASSWORD    — OpenClaw gateway password
// ─────────────────────────────────────────────────────────────────────────────
const WebSocket = require('ws');
const crypto = require('crypto');

const ROUTER = process.env.ROUTER_WS;
const LOCAL = 'ws://127.0.0.1:' + (process.env.LOCAL_PORT || '19001');
const AUTH = JSON.parse(process.env.AUTH_JSON);
const GW_PASSWORD = process.env.GW_PASSWORD || '';

if (!ROUTER) { console.error('[bridge] ROUTER_WS is required'); process.exit(1); }

let routerWs = null;
let localWs = null;
let authenticated = false;
let shuttingDown = false;
let pingInterval = null;
let readySent = false;

// ── Router connection ──────────────────────────────────────────────────────
function connectRouter() {
  if (shuttingDown) return;
  console.log('[bridge] → ' + ROUTER);
  routerWs = new WebSocket(ROUTER);

  routerWs.on('open', () => {
    console.log('[bridge] Router connected, authenticating...');
    routerWs.send(JSON.stringify(AUTH));
  });

  routerWs.on('message', (raw) => {
    const data = raw.toString();
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'gateway_auth_ok') {
        console.log('[bridge] Authenticated — forwarding active');
        authenticated = true;
        connectLocal();
        return;
      }
      if (msg.type === 'gateway_auth_error') {
        console.error('[bridge] Auth failed:', msg.error);
        process.exit(1);
      }
      // Handle config update from router — sync LiteLLM key to openclaw.json
      if (msg.type === 'config_update' && msg.litellmKey) {
        handleConfigUpdate(msg);
        return;
      }
      // Handle exec command from router — run locally, return output
      if (msg.type === 'exec' && msg.id && msg.command) {
        handleExec(msg);
        return;
      }
    } catch {}
    // Forward router → local gateway
    if (authenticated && localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(data);
    }
  });

  routerWs.on('close', (code) => {
    console.log('[bridge] Router disconnected:', code);
    authenticated = false;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (localWs) { try { localWs.close(); } catch {} localWs = null; }
    if (!shuttingDown) setTimeout(connectRouter, 5000);
  });

  routerWs.on('error', (e) => console.error('[bridge] Router error:', e.message));

  // Keepalive ping every 30s (clear old interval on reconnect)
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (routerWs?.readyState === WebSocket.OPEN) routerWs.ping();
  }, 30000);
}

// ── Local gateway connection ───────────────────────────────────────────────
function connectLocal() {
  if (shuttingDown) return;
  console.log('[bridge] → ' + LOCAL);
  localWs = new WebSocket(LOCAL);
  let gwReady = false;

  localWs.on('open', () => console.log('[bridge] Local WS opened, waiting for handshake...'));

  localWs.on('message', (raw) => {
    const data = raw.toString();
    try {
      const msg = JSON.parse(data);

      // Gateway handshake: respond to connect.challenge
      if (!gwReady && msg.type === 'event' && msg.event === 'connect.challenge') {
        console.log('[bridge] Gateway challenge received, authenticating...');
        localWs.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'gateway-client', version: '1.0.0', platform: 'linux', mode: 'backend' },
            caps: [],
            auth: { password: GW_PASSWORD },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
          },
        }));
        return;
      }

      // Handshake complete
      if (!gwReady && msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        gwReady = true;
        console.log('[bridge] Gateway handshake complete — bridge active');
        // Signal pm2 that bridge is fully ready (router + local gateway connected)
        if (!readySent && typeof process.send === 'function') {
          process.send('ready');
          readySent = true;
        }
        return;
      }

      // Handshake error
      if (!gwReady && msg.type === 'res' && !msg.ok) {
        console.error('[bridge] Gateway handshake failed:', msg.error?.message || JSON.stringify(msg.error));
        return;
      }
    } catch {}

    // Forward local gateway → router (only after handshake)
    if (gwReady && routerWs && routerWs.readyState === WebSocket.OPEN) {
      routerWs.send(data);
    }
  });

  localWs.on('close', () => {
    gwReady = false;
    console.log('[bridge] Local gateway disconnected, reconnecting...');
    if (!shuttingDown) setTimeout(connectLocal, 3000);
  });

  localWs.on('error', (e) => console.error('[bridge] Local error:', e.message));
}

// ── Config update: sync LiteLLM key from router to openclaw.json ─────────
function handleConfigUpdate(msg) {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const chatId = process.env.CHAT_ID || '';
  const user = `xai${chatId.slice(0, 28)}`;
  const configPath = `/home/${user}/.openclaw/openclaw.json`;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const currentKey = config.models?.providers?.litellm?.apiKey || '';

    if (currentKey === msg.litellmKey) {
      console.log('[bridge] LiteLLM key unchanged — no restart needed');
      return;
    }

    config.models.providers.litellm.apiKey = msg.litellmKey;
    if (msg.routerUrl) {
      config.models.providers.litellm.baseUrl = `${msg.routerUrl}/v1`;
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('[bridge] Updated openclaw.json with new LiteLLM key');

    // Restart openclaw to pick up new key
    try { execSync('pm2 restart openclaw 2>/dev/null', { timeout: 5000 }); } catch {}
    console.log('[bridge] Restarted openclaw');
  } catch (err) {
    console.error('[bridge] Config update failed:', err.message);
  }
}

// ── Exec: run commands locally, stream output back to router ──────────────
function handleExec(msg) {
  const { id, command, cwd, user } = msg;
  const { spawn } = require('child_process');
  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[bridge] exec: ${command.slice(0, 80)}`);
  const child = spawn(args[0], args[1], { ...args[2], env: { ...process.env, HOME: `/home/${user || 'root'}` } });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    // Stream partial output back to router
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_output', id, data: chunk.toString() }));
    }
  });

  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code, stdout, stderr }));
    }
  });

  // Timeout: kill after 5 minutes
  setTimeout(() => {
    try { child.kill(); } catch {}
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code: -1, stdout, stderr: stderr + '\nTimeout (300s)' }));
    }
  }, 300000);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[bridge] ${signal} received, shutting down...`);
  shuttingDown = true;
  if (localWs) try { localWs.close(); } catch {}
  if (routerWs) try { routerWs.close(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

connectRouter();

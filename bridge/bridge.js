#!/usr/bin/env node
// ─── Bridge Management WS ──────────────────────────────────────────────────
// Connects to the router via reverse WebSocket and authenticates as a shared
// bridge (not a user instance). Handles exec commands from the router for
// container management. Workspace containers connect independently.
//
// Environment variables:
//   ROUTER_WS  — ws://router:8080/ws/gateway
//   AUTH_JSON   — JSON string: { type: 'gateway_auth', instanceId, instanceToken }
// ─────────────────────────────────────────────────────────────────────────────
const WebSocket = require('ws');

const ROUTER = process.env.ROUTER_WS;
const AUTH = JSON.parse(process.env.AUTH_JSON);

if (!ROUTER) { console.error('[bridge] ROUTER_WS is required'); process.exit(1); }

let routerWs = null;
let authenticated = false;
let shuttingDown = false;
let pingInterval = null;

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
        console.log('[bridge] Authenticated as shared bridge');
        authenticated = true;
        return;
      }
      if (msg.type === 'gateway_auth_error') {
        console.error('[bridge] Auth failed:', msg.error);
        process.exit(1);
      }
      // Handle exec command from router — run locally, return output
      if (msg.type === 'exec' && msg.id && msg.command) {
        handleExec(msg);
        return;
      }
    } catch {}
  });

  routerWs.on('close', (code) => {
    console.log('[bridge] Router disconnected:', code);
    authenticated = false;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (!shuttingDown) setTimeout(connectRouter, 5000);
  });

  routerWs.on('error', (e) => console.error('[bridge] Router error:', e.message));

  // Keepalive ping every 30s (clear old interval on reconnect)
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (routerWs?.readyState === WebSocket.OPEN) routerWs.ping();
  }, 30000);
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
  if (routerWs) try { routerWs.close(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

connectRouter();

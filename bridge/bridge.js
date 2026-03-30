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

// Derive ROUTER_WS from ROUTER_URL if not explicitly set
const ROUTER = process.env.ROUTER_WS
  || (process.env.ROUTER_URL
    ? process.env.ROUTER_URL.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws/gateway'
    : null);
const AUTH = JSON.parse(process.env.AUTH_JSON || '{}');

if (!ROUTER) { console.error('[bridge] ROUTER_WS or ROUTER_URL is required'); process.exit(1); }

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
      // Handle scan command — router requests immediate container scan
      if (msg.type === 'scan') {
        const compose = require('./compose-manager');
        const instances = compose.listInstances();
        routerWs.send(JSON.stringify({ type: 'scan_result', instances }));
        return;
      }
      // Handle provision command — create a workspace container
      if (msg.type === 'provision_instance' && msg.instanceId) {
        handleProvision(msg);
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

// ── Provision: create a workspace container via Docker ────────────────────

// Validate env var key/value: keys must be alphanumeric/underscore, values must not contain control chars
const ENV_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENV_VAL_FORBIDDEN_RE = /[\x00-\x08\x0e-\x1f\x7f]/; // control chars except \t \n \r

function handleProvision(msg) {
  const { instanceId, image, env } = msg;
  const { execFileSync } = require('child_process');

  // Validate instanceId (alphanumeric, dash, underscore only)
  if (!instanceId || !/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
    console.warn(`[bridge] Provision rejected: invalid instanceId: ${instanceId}`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'failed', error: 'Invalid instanceId' }));
    }
    return;
  }

  // Validate image name (basic Docker image ref format)
  const safeImage = image || 'public.ecr.aws/s3b3q6t2/xaiworkspace-docker:latest';
  if (!/^[a-zA-Z0-9_./:@-]+$/.test(safeImage)) {
    console.warn(`[bridge] Provision rejected: invalid image name: ${safeImage}`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'failed', error: 'Invalid image name' }));
    }
    return;
  }

  console.log(`[bridge] Provisioning workspace: ${instanceId} (image: ${safeImage})`);

  try {
    const args = ['run', '-d', '--name', instanceId, '--restart', 'unless-stopped'];

    // Pass environment variables with validation
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (!ENV_KEY_RE.test(k)) {
          console.warn(`[bridge] Provision: skipping invalid env key: ${k}`);
          continue;
        }
        const val = String(v);
        if (ENV_VAL_FORBIDDEN_RE.test(val)) {
          console.warn(`[bridge] Provision: skipping env ${k} with forbidden control chars`);
          continue;
        }
        args.push('-e', `${k}=${val}`);
      }
    }

    args.push(safeImage);

    execFileSync('docker', args, { timeout: 60_000 });
    console.log(`[bridge] Workspace ${instanceId} started`);

    // Notify router
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({
        type: 'provision_result',
        instanceId,
        status: 'started',
      }));
    }
  } catch (err) {
    console.error(`[bridge] Provision failed for ${instanceId}:`, err.message);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({
        type: 'provision_result',
        instanceId,
        status: 'failed',
        error: err.message,
      }));
    }
  }
}

// ── Exec: run commands locally, stream output back to router ──────────────
const MAX_COMMAND_LENGTH = 10240; // 10KB

// Allowlisted command prefixes — only these commands can be executed via the router.
// The bridge has Docker socket access, so this limits the blast radius of a compromised router.
const EXEC_ALLOWLIST = [
  'docker ',
  'docker-compose ',
  'docker compose ',
  'pm2 ',
  'curl ',
  'cat /data/',
  'ls ',
  'echo ',
  'whoami',
  'hostname',
  'uname ',
  'df ',
  'free ',
  'ps ',
];

function isCommandAllowed(command) {
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

function handleExec(msg) {
  const { id, command, cwd, user } = msg;
  const { spawn } = require('child_process');

  // Validate command length
  if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
    console.warn(`[bridge] exec rejected: invalid command (length=${command?.length || 0})`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid or too long' }));
    }
    return;
  }

  // Validate command against allowlist
  if (!isCommandAllowed(command)) {
    console.warn(`[bridge] exec rejected: command not in allowlist: ${command.slice(0, 80)}`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: not in allowlist' }));
    }
    return;
  }

  // Validate user field if present (alphanumeric, underscore, dash only)
  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) {
    console.warn(`[bridge] exec rejected: invalid user field`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid user' }));
    }
    return;
  }

  // Validate cwd if present (prevent path traversal)
  if (cwd && (cwd.includes('..') || !cwd.startsWith('/'))) {
    console.warn(`[bridge] exec rejected: invalid cwd: ${cwd}`);
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid cwd' }));
    }
    return;
  }

  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[bridge] exec: ${command.slice(0, 60)}... (${command.length} bytes)`);
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

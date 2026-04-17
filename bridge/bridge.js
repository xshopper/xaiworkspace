#!/usr/bin/env node
// ─── Bridge Management WS (Multi-Router) ─────────────────────────────────
// Connects to one or more routers via reverse WebSocket and authenticates as
// a shared bridge. Handles exec commands from any router for container
// management. Workspace containers connect independently.
//
// Credentials: /data/routers.json — array of { routerUrl, bridgeId, bridgeToken }
// ──────────────────────────────────────────────────────────────────────────
const WebSocket = require('ws');
const fs = require('fs');

const ROUTERS_FILE = '/data/routers.json';

// ── Multi-router connection state ─────────────────────────────────────────
// routerUrl → { ws, bridgeId, bridgeToken, authenticated, pingInterval, reconnectTimer }
const connections = new Map();
let shuttingDown = false;
let primaryHandled = false;

// ── Load routers from /data/routers.json ──────────────────────────────────
function loadRouters() {
  try { return JSON.parse(fs.readFileSync(ROUTERS_FILE, 'utf8')); }
  catch { return []; }
}

// Watch routers.json for changes — hot-reload new routers without restart
let routersWatcher = null;
function watchRoutersFile() {
  if (routersWatcher) return;
  try {
    routersWatcher = fs.watch(ROUTERS_FILE, { persistent: false }, () => {
      const routers = loadRouters();
      // Connect to any new routers
      for (const entry of routers) {
        if (!connections.has(entry.routerUrl)) {
          console.log(`[bridge] New router detected: ${entry.routerUrl}`);
          connectRouter(entry);
        }
      }
      // Disconnect from removed routers
      const routerUrls = new Set(routers.map(r => r.routerUrl));
      for (const [url, conn] of connections) {
        if (!routerUrls.has(url)) {
          console.log(`[bridge] Router removed: ${url}`);
          closeConnection(conn);
          connections.delete(url);
        }
      }
    });
    routersWatcher.on('error', () => {
      routersWatcher = null;
      // Retry after a delay
      setTimeout(watchRoutersFile, 10000);
    });
  } catch { /* best effort */ }
}

/** Clean up a connection's resources. */
function closeConnection(conn) {
  if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
  if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
  try { conn.ws?.close(); } catch {}
}

// ── Router connection (per-router) ────────────────────────────────────────
function connectRouter(entry) {
  if (shuttingDown) return;
  const { routerUrl, bridgeId, bridgeToken } = entry;
  if (!routerUrl || !bridgeId || !bridgeToken) {
    console.warn(`[bridge] Skipping router with missing credentials: ${routerUrl || 'unknown'}`);
    return;
  }

  // Validate URL scheme. Require HTTPS (mapped to wss://) so the bridge token
  // sent in the `gateway_auth` message cannot be captured on the network path.
  // Plain HTTP is permitted only for loopback hostnames (local development).
  let parsedRouterUrl;
  try {
    parsedRouterUrl = new URL(routerUrl);
  } catch {
    console.error(`[bridge] Invalid router URL: ${routerUrl}`);
    return;
  }
  const isLoopback = parsedRouterUrl.hostname === 'localhost'
    || parsedRouterUrl.hostname === '127.0.0.1'
    || parsedRouterUrl.hostname === '::1';
  if (parsedRouterUrl.protocol !== 'https:'
    && !(parsedRouterUrl.protocol === 'http:' && isLoopback)) {
    console.error(`[bridge] Refusing insecure router URL (HTTPS required for non-loopback hosts): ${routerUrl}`);
    return;
  }

  // Close existing connection if any (prevents connection leak on reconnect)
  const existing = connections.get(routerUrl);
  if (existing) closeConnection(existing);

  const wsUrl = routerUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws/gateway';
  console.log(`[bridge] → ${wsUrl}`);

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error(`[bridge] Failed to create WS to ${routerUrl}: ${e.message}`);
    return;
  }

  const conn = { ws, bridgeId, bridgeToken, authenticated: false, pingInterval: null, reconnectTimer: null };
  connections.set(routerUrl, conn);

  ws.on('open', () => {
    console.log(`[bridge] Connected to ${routerUrl}, authenticating...`);
    ws.send(JSON.stringify({
      type: 'gateway_auth',
      instanceId: bridgeId,
      instanceToken: bridgeToken,
      multiRouter: true,
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg, conn, routerUrl);
    } catch (e) {
      console.error(`[bridge] Message handler error (${routerUrl}):`, e.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[bridge] Disconnected from ${routerUrl}:`, code);
    conn.authenticated = false;
    if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
    if (!shuttingDown) {
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        const routers = loadRouters();
        const updated = routers.find(r => r.routerUrl === routerUrl);
        if (updated) connectRouter(updated);
        else connections.delete(routerUrl);
      }, 5000);
    }
  });

  ws.on('error', (e) => console.error(`[bridge] Router error (${routerUrl}):`, e.message));

  // Keepalive ping every 30s
  conn.pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);
}

// ── Message handler (shared across all router connections) ────────────────
function handleMessage(msg, conn, routerUrl) {
  const { ws } = conn;

  // Auth responses are always processed
  if (msg.type === 'gateway_auth_ok') {
    console.log(`[bridge] Authenticated with ${routerUrl}`);
    conn.authenticated = true;
    return;
  }
  if (msg.type === 'gateway_auth_error') {
    console.error(`[bridge] Auth failed (${routerUrl}):`, msg.error);
    return;
  }

  // All other commands require authentication
  if (!conn.authenticated) {
    console.warn(`[bridge] Ignoring ${msg.type} from ${routerUrl} — not authenticated`);
    return;
  }

  // ── Exec command ──────────────────────────────────────────────────────
  if (msg.type === 'exec' && msg.id && msg.command) {
    handleExec(msg, ws);
    return;
  }

  // ── Container scan ────────────────────────────────────────────────────
  if (msg.type === 'scan') {
    const compose = require('./compose-manager');
    const instances = compose.listInstances();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'scan_result', instances }));
    }
    return;
  }

  // ── Provision workspace ───────────────────────────────────────────────
  if (msg.type === 'provision_instance' && msg.instanceId) {
    handleProvision(msg, ws);
    return;
  }

  // ── Bridge scan (multi-router: always empty) ──────────────────────────
  if (msg.type === 'scan_bridges') {
    console.log(`[bridge] Scan requested by ${routerUrl} — multi-router, returning empty`);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'scan_bridges_result', bridges: [] }));
    }
    return;
  }

  // ── Bridge adopt (should not happen in multi-router) ──────────────────
  if (msg.type === 'bridge_adopt') {
    console.log(`[bridge] Ignoring bridge_adopt from ${routerUrl} — multi-router bridge`);
    return;
  }

  // ── Bridge primary (dedup — only act on first) ────────────────────────
  if (msg.type === 'bridge_primary') {
    if (primaryHandled) {
      console.log(`[bridge] bridge_primary from ${routerUrl} — already handled`);
      return;
    }
    primaryHandled = true;
    console.log(`[bridge] Primary bridge confirmed by ${routerUrl}`);
    try {
      fs.writeFileSync('/data/bridge_primary', 'true');
    } catch { /* best effort */ }
    return;
  }

  // ── Instance lifecycle commands ───────────────────────────────────────
  if (msg.type === 'start_instance' && msg.instanceId) {
    const id = msg.instanceId;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    console.log(`[bridge] Starting instance: ${id}`);
    const { execFile } = require('child_process');
    execFile('docker', ['start', id], { timeout: 15000 }, (err) => {
      if (err) console.warn(`[bridge] Failed to start ${id}: ${err.message}`);
      else console.log(`[bridge] Started instance: ${id}`);
    });
    return;
  }

  if (msg.type === 'stop_instance' && msg.instanceId) {
    const id = msg.instanceId;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    console.log(`[bridge] Stopping instance: ${id}`);
    const { execFile } = require('child_process');
    execFile('docker', ['stop', id], { timeout: 15000 }, (err) => {
      if (err) console.warn(`[bridge] Failed to stop ${id}: ${err.message}`);
      else console.log(`[bridge] Stopped instance: ${id}`);
    });
    return;
  }

  if (msg.type === 'remove_instance' && msg.instanceId) {
    const id = msg.instanceId;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    console.log(`[bridge] Removing instance: ${id}`);
    const { execFile } = require('child_process');
    execFile('docker', ['rm', '-f', id], { timeout: 15000 }, (err) => {
      if (err) console.warn(`[bridge] Failed to remove ${id}: ${err.message}`);
      else console.log(`[bridge] Removed instance: ${id}`);
    });
    return;
  }

  if (msg.type === 'stop_orphan' && msg.instanceId) {
    const orphanId = msg.instanceId;
    if (!/^[a-zA-Z0-9_-]+$/.test(orphanId)) return;
    const { execFile } = require('child_process');
    execFile('docker', ['inspect', '--format', '{{.State.Running}}', orphanId], { timeout: 5000 }, (err) => {
      if (err) return;
      console.log(`[bridge] Stopping orphaned instance: ${orphanId}`);
      execFile('docker', ['stop', '-t', '5', orphanId], { timeout: 15000 }, () => {
        execFile('docker', ['rm', orphanId], { timeout: 10000 }, (rmErr) => {
          if (rmErr) console.warn(`[bridge] Failed to remove orphan ${orphanId}: ${rmErr.message}`);
          else console.log(`[bridge] Removed orphaned instance: ${orphanId}`);
        });
      });
    });
    return;
  }

  // ── PM2 process listing ───────────────────────────────────────────────
  if (msg.type === 'pm2_list') {
    const { execFile } = require('child_process');
    execFile('pm2', ['jlist', '--no-color'], { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const processes = [];
      if (!err && stdout) {
        try {
          for (const p of JSON.parse(stdout.trim())) {
            processes.push({
              name: p.name,
              status: p.pm2_env?.status || 'unknown',
              restarts: p.pm2_env?.restart_time || 0,
              cpu: p.monit?.cpu || 0,
              memory: p.monit?.memory || 0,
            });
          }
        } catch {}
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pm2_list_result', processes }));
      }
    });
    return;
  }

  if (msg.type === 'workspace_pm2_list') {
    const compose = require('./compose-manager');
    const instances = compose.listInstances();
    const result = {};
    const running = instances.filter(i => i.status === 'running');
    let pending = running.length;
    if (pending === 0) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'workspace_pm2_result', instances: result }));
      }
      return;
    }
    for (const inst of running) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(inst.name)) { if (--pending === 0 && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'workspace_pm2_result', instances: result })); continue; }
      const { execFile } = require('child_process');
      execFile('docker', [
        'exec', inst.name, 'sh', '-c',
        'PM2_HOME=$(find /home -maxdepth 2 -name .pm2 -type d 2>/dev/null | head -1); [ -n "$PM2_HOME" ] && PM2_HOME="$PM2_HOME" pm2 jlist --no-color 2>/dev/null || echo "[]"',
      ], { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) {
          try {
            const pm2List = JSON.parse(stdout.trim());
            if (pm2List.length > 0) {
              result[inst.name] = pm2List.map(p => ({
                name: p.name,
                status: p.pm2_env?.status || 'unknown',
                restarts: p.pm2_env?.restart_time || 0,
                cpu: p.monit?.cpu || 0,
                memory: p.monit?.memory || 0,
              }));
            }
          } catch {}
        }
        if (--pending === 0 && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'workspace_pm2_result', instances: result }));
        }
      });
    }
    return;
  }

  // ── Update check ──────────────────────────────────────────────────────
  if (msg.type === 'check_update') {
    console.log(`[bridge] Update check requested by ${routerUrl}`);
    const { execFile } = require('child_process');
    execFile('pm2', ['restart', 'updater'], { timeout: 10000 }, (err) => {
      if (err) console.error('[bridge] Failed to trigger update:', err.message);
      else if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'update_check_started' }));
    });
    return;
  }
}

// ── Update progress forwarding ────────────────────────────────────────────
const UPDATE_PROGRESS_FILE = '/data/update_progress';
let lastUpdateProgressTs = 0;

const updateProgressInterval = setInterval(() => {
  try {
    const raw = fs.readFileSync(UPDATE_PROGRESS_FILE, 'utf8');
    const progress = JSON.parse(raw);
    if (progress.ts && progress.ts > lastUpdateProgressTs) {
      lastUpdateProgressTs = progress.ts;
      const msg = JSON.stringify({
        type: 'bridge_update_progress',
        stage: progress.stage,
        message: progress.message,
      });
      for (const [, conn] of connections) {
        if (conn.ws?.readyState === WebSocket.OPEN) {
          conn.ws.send(msg);
        }
      }
      if (progress.stage === 'updated' || progress.stage === 'failed' || progress.stage === 'idle') {
        try { fs.unlinkSync(UPDATE_PROGRESS_FILE); } catch {}
      }
    }
  } catch { /* file doesn't exist or parse error — ignore */ }
}, 2000);

// ── Provision: create a workspace container via Docker ────────────────────

const ENV_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENV_VAL_FORBIDDEN_RE = /[\x00-\x08\x0e-\x1f\x7f]/;

function handleProvision(msg, ws) {
  const { instanceId, image, env } = msg;

  if (!instanceId || !/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
    console.warn(`[bridge] Provision rejected: invalid instanceId: ${instanceId}`);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'failed', error: 'Invalid instanceId' }));
    }
    return;
  }

  const safeImage = image || 'public.ecr.aws/s3b3q6t2/xaiworkspace-docker:latest';
  if (!/^[a-zA-Z0-9_./:@-]+$/.test(safeImage)) {
    console.warn(`[bridge] Provision rejected: invalid image name: ${safeImage}`);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'failed', error: 'Invalid image name' }));
    }
    return;
  }

  console.log(`[bridge] Provisioning workspace: ${instanceId} (image: ${safeImage})`);

  const sendProgress = (stage, message) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'provision_progress', instanceId, stage, message }));
    }
  };

  const { execFile } = require('child_process');

  (async () => {
    try {
      sendProgress('pulling', 'Pulling image...');
      try {
        await new Promise((resolve, reject) => {
          execFile('docker', ['pull', safeImage], { timeout: 300_000 }, (err) => err ? reject(err) : resolve());
        });
      } catch (pullErr) {
        console.warn(`[bridge] Image pull failed/skipped for ${safeImage}: ${pullErr.message}`);
      }

      sendProgress('starting', 'Starting container...');
      const args = ['run', '-d', '--name', instanceId, '--restart', 'unless-stopped'];

      if (env) {
        for (const [k, v] of Object.entries(env)) {
          if (!ENV_KEY_RE.test(k)) { console.warn(`[bridge] Provision: skipping invalid env key: ${k}`); continue; }
          const val = String(v);
          if (ENV_VAL_FORBIDDEN_RE.test(val)) { console.warn(`[bridge] Provision: skipping env ${k} with forbidden control chars`); continue; }
          args.push('-e', `${k}=${val}`);
        }
      }
      args.push(safeImage);

      await new Promise((resolve, reject) => {
        execFile('docker', args, { timeout: 60_000 }, (err) => err ? reject(err) : resolve());
      });
      console.log(`[bridge] Workspace ${instanceId} started`);

      sendProgress('ready', 'Instance is ready');
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'started' }));
      }
    } catch (err) {
      console.error(`[bridge] Provision failed for ${instanceId}:`, err.message);
      sendProgress('failed', err.message);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'provision_result', instanceId, status: 'failed', error: err.message }));
      }
    }
  })();
}

// ── Exec: run commands locally, stream output back to router ──────────────
const MAX_COMMAND_LENGTH = 10240;

const EXEC_ALLOWLIST = [
  'docker ', 'docker-compose ', 'docker compose ', 'pm2 ',
  'curl ', 'cat /data/', 'ls ', 'echo ',
  'whoami', 'hostname', 'uname ', 'df ', 'free ', 'ps ',
];

function isCommandAllowed(command) {
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

function handleExec(msg, ws) {
  const { id, command, cwd, user } = msg;
  const { spawn } = require('child_process');

  function sendResult(code, stdout, stderr) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_result', id, code, stdout, stderr }));
    }
  }

  if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
    sendResult(-1, '', 'Command rejected: invalid or too long');
    return;
  }

  if (!isCommandAllowed(command)) {
    console.warn(`[bridge] exec rejected: not in allowlist: ${command.slice(0, 80)}`);
    sendResult(-1, '', 'Command rejected: not in allowlist');
    return;
  }

  // Block shell metacharacters + newlines that enable command injection
  if (/[;`|$()><&\n\r]/.test(command)) {
    console.warn(`[bridge] exec rejected: disallowed characters: ${command.slice(0, 80)}`);
    sendResult(-1, '', 'Command rejected: disallowed characters');
    return;
  }

  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) {
    sendResult(-1, '', 'Command rejected: invalid user');
    return;
  }

  if (cwd && (cwd.includes('..') || !cwd.startsWith('/'))) {
    sendResult(-1, '', 'Command rejected: invalid cwd');
    return;
  }

  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[bridge] exec: ${command.slice(0, 60)}... (${command.length} bytes)`);
  const child = spawn(args[0], args[1], { ...args[2], detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: `/home/${user || 'root'}` } });

  let stdout = '';
  let stderr = '';

  let execTimeout;
  let timedOut = false;

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_output', id, data: chunk.toString() }));
    }
  });

  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    clearTimeout(execTimeout);
    if (!timedOut) sendResult(code, stdout, stderr);
  });

  execTimeout = setTimeout(() => {
    timedOut = true;
    if (child.pid > 0) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
    sendResult(-1, stdout, stderr + '\nTimeout (300s)');
  }, 300_000);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[bridge] ${signal} received, shutting down...`);
  shuttingDown = true;
  clearInterval(updateProgressInterval);
  for (const [, conn] of connections) {
    closeConnection(conn);
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────────
function connectAll() {
  const routers = loadRouters();
  if (routers.length === 0) {
    console.warn('[bridge] No routers in /data/routers.json — waiting for pairing server');
    setTimeout(connectAll, 5000);
    return;
  }
  console.log(`[bridge] Connecting to ${routers.length} router(s)...`);
  for (const entry of routers) {
    connectRouter(entry);
  }
  watchRoutersFile();
}

connectAll();

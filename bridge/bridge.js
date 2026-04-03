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
const http = require('http');
const fs = require('fs');

// Derive ROUTER_WS from ROUTER_URL if not explicitly set
const ROUTER = process.env.ROUTER_WS
  || (process.env.ROUTER_URL
    ? process.env.ROUTER_URL.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws/gateway'
    : null);

// Read auth credentials: env var first, then /data/auth.json (written by pairing server)
const AUTH_FILE = '/data/auth.json';
function loadAuth() {
  if (process.env.AUTH_JSON) return JSON.parse(process.env.AUTH_JSON);
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return {}; }
}
let AUTH = loadAuth();

if (!ROUTER) { console.error('[bridge] ROUTER_WS or ROUTER_URL is required'); process.exit(1); }

let routerWs = null;
let authenticated = false;
let shuttingDown = false;
let pingInterval = null;

const BRIDGE_ID = process.env.BRIDGE_ID || process.env.INSTANCE_ID || '';

// ── Docker API (scan for other bridges) ───────────────────────────────────

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

/**
 * Scan Docker for other bridge containers.
 * Returns array of bridge IDs found on this Docker host.
 */
async function scanDockerForBridges() {
  const containers = await dockerApiGet('/containers/json');
  if (!containers || !Array.isArray(containers)) return [];

  const selfHostname = require('os').hostname();
  const bridges = [];

  for (const c of containers) {
    // Skip self
    if (c.Id?.startsWith(selfHostname)) continue;
    const containerName = c.Names?.[0]?.replace(/^\//, '') || '';
    if (containerName === BRIDGE_ID) continue;
    if (c.State !== 'running') continue;
    // Must expose port 3100 internally
    if (!c.Ports?.some(p => p.PrivatePort === 3100)) continue;

    // Get BRIDGE_ID from env vars
    const inspect = await dockerApiGet(`/containers/${c.Id}/json`);
    if (!inspect?.Config?.Env) continue;
    const bridgeIdEnv = inspect.Config.Env.find(e => e.startsWith('BRIDGE_ID='));
    const candidateId = bridgeIdEnv ? bridgeIdEnv.slice('BRIDGE_ID='.length) : containerName;
    if (candidateId === BRIDGE_ID) continue;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(candidateId)) continue;

    console.log(`[bridge] Found bridge on same host: ${candidateId} (${c.Id.slice(0, 12)})`);
    bridges.push(candidateId);
  }

  console.log(`[bridge] Scan complete: ${bridges.length} other bridge(s) found`);
  return bridges;
}

// ── Router connection ──────────────────────────────────────────────────────
function connectRouter() {
  if (shuttingDown) return;
  // Re-read auth file on each reconnect — pairing server may have updated it
  AUTH = loadAuth();
  if (!AUTH.instanceId || !AUTH.instanceToken) {
    console.warn('[bridge] No credentials yet (waiting for pairing server to register)');
    setTimeout(connectRouter, 5000);
    return;
  }
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
      // Handle scan_bridges — router asks us to scan Docker for other bridges
      if (msg.type === 'scan_bridges') {
        console.log('[bridge] Router requested bridge scan');
        scanDockerForBridges().then(bridges => {
          if (routerWs?.readyState === WebSocket.OPEN) {
            routerWs.send(JSON.stringify({ type: 'scan_bridges_result', bridges }));
          }
        });
        return;
      }
      // Handle bridge_adopt — router found an existing bridge on same host
      if (msg.type === 'bridge_adopt') {
        shuttingDown = true; // prevent reconnect after WS closes
        console.log('');
        console.log('══════════════════════════════════════');
        console.log('  Existing bridge found!');
        console.log(`  Joined: ${msg.targetBridgeId}`);
        if (msg.pairingCode) {
          console.log(`  Pairing code: ${msg.pairingCode}`);
        }
        console.log('  You are now connected.');
        console.log('══════════════════════════════════════');
        console.log('');
        // Kill the entire PM2 runtime so the container exits (--rm cleans up).
        // process.exit(0) only kills bridge.js — PM2 would restart it.
        const { execFile } = require('child_process');
        setTimeout(() => {
          execFile('pm2', ['kill'], { timeout: 10000 }, () => process.exit(0));
        }, 1000);
        return;
      }
      // Handle bridge_primary — no existing bridge, become the primary
      if (msg.type === 'bridge_primary') {
        console.log('[bridge] Router confirmed: this is the primary bridge');
        // If running without host port bindings, recreate with ports
        // Signal server.js to handle port re-creation via the shared file system
        try {
          fs.writeFileSync('/data/bridge_primary', 'true');
        } catch { /* best effort */ }
        return;
      }
      // Handle start_instance — router tells us to start a stopped workspace container
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
      // Handle stop_instance — router tells us to stop a workspace container
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
      // Handle remove_instance — router tells us to stop and remove a workspace container
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
      // Handle stop_orphan — router tells us to stop an orphaned workspace container
      if (msg.type === 'stop_orphan' && msg.instanceId) {
        const orphanId = msg.instanceId;
        if (!/^[a-zA-Z0-9_-]+$/.test(orphanId)) return;
        // Only act if container exists locally
        const { execFile } = require('child_process');
        execFile('docker', ['inspect', '--format', '{{.State.Running}}', orphanId], { timeout: 5000 }, (err, stdout) => {
          if (err) return; // container doesn't exist locally — ignore
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
      // Handle update command — trigger immediate update check via PM2
      if (msg.type === 'check_update') {
        console.log('[bridge] Router requested update check');
        try {
          const { execFileSync } = require('child_process');
          execFileSync('pm2', ['restart', 'updater'], { timeout: 10000, stdio: 'pipe' });
          if (routerWs?.readyState === 1) {
            routerWs.send(JSON.stringify({ type: 'update_check_started' }));
          }
        } catch (err) {
          console.error('[bridge] Failed to trigger update:', err.message);
        }
        return;
      }
    } catch (e) {
      console.error('[bridge] Message handler error:', e.message);
    }
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

// ── Update progress forwarding ────────────────────────────────────────────
// The updater.js process writes progress to /data/update_progress.
// We watch the file and forward changes to the router over WS.

const UPDATE_PROGRESS_FILE = '/data/update_progress';
let lastUpdateProgressTs = 0;

setInterval(() => {
  try {
    const raw = fs.readFileSync(UPDATE_PROGRESS_FILE, 'utf8');
    const progress = JSON.parse(raw);
    if (progress.ts && progress.ts > lastUpdateProgressTs) {
      lastUpdateProgressTs = progress.ts;
      if (routerWs?.readyState === WebSocket.OPEN) {
        routerWs.send(JSON.stringify({
          type: 'bridge_update_progress',
          stage: progress.stage,
          message: progress.message,
        }));
      }
      // Clean up on terminal stages
      if (progress.stage === 'updated' || progress.stage === 'failed' || progress.stage === 'idle') {
        try { fs.unlinkSync(UPDATE_PROGRESS_FILE); } catch {}
      }
    }
  } catch { /* file doesn't exist or parse error — ignore */ }
}, 2000);

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

  const sendProgress = (stage, message) => {
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'provision_progress', instanceId, stage, message }));
    }
  };

  // Run provisioning async so we can send progress events
  (async () => {
    try {
      // Step 1: Pull image
      sendProgress('pulling', 'Pulling image...');
      try {
        execFileSync('docker', ['pull', safeImage], { timeout: 300_000, stdio: 'pipe' });
      } catch (pullErr) {
        console.warn(`[bridge] Image pull failed/skipped for ${safeImage}: ${pullErr.stderr?.toString().trim() || pullErr.message}`);
        // Continue — image may be cached locally
      }

      // Step 2: Create and start container
      sendProgress('starting', 'Starting container...');
      const args = ['run', '-d', '--name', instanceId, '--restart', 'unless-stopped'];

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

      execFileSync('docker', args, { timeout: 60_000, stdio: 'pipe' });
      console.log(`[bridge] Workspace ${instanceId} started`);

      // Step 4: Done
      sendProgress('ready', 'Instance is ready');
      if (routerWs?.readyState === WebSocket.OPEN) {
        routerWs.send(JSON.stringify({
          type: 'provision_result',
          instanceId,
          status: 'started',
        }));
      }
    } catch (err) {
      console.error(`[bridge] Provision failed for ${instanceId}:`, err.message);
      sendProgress('failed', err.message);
      if (routerWs?.readyState === WebSocket.OPEN) {
        routerWs.send(JSON.stringify({
          type: 'provision_result',
          instanceId,
          status: 'failed',
          error: err.message,
        }));
      }
    }
  })();
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

  function sendResult(code, stdout, stderr) {
    if (routerWs?.readyState === WebSocket.OPEN) {
      routerWs.send(JSON.stringify({ type: 'exec_result', id, code, stdout, stderr }));
    }
  }

  // Validate command length
  if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
    console.warn(`[bridge] exec rejected: invalid command (length=${command?.length || 0})`);
    sendResult(-1, '', 'Command rejected: invalid or too long');
    return;
  }

  // Validate command against allowlist
  if (!isCommandAllowed(command)) {
    console.warn(`[bridge] exec rejected: command not in allowlist: ${command.slice(0, 80)}`);
    sendResult(-1, '', 'Command rejected: not in allowlist');
    return;
  }

  // Block shell metacharacters that enable command injection.
  // Note: curly braces are intentionally allowed for docker --format '{{.Names}}' patterns.
  if (/[;`|$()><]/.test(command)) {
    console.warn(`[bridge] exec rejected: disallowed shell characters: ${command.slice(0, 80)}`);
    sendResult(-1, '', 'Command rejected: disallowed characters');
    return;
  }

  // Validate user field if present (alphanumeric, underscore, dash only)
  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) {
    console.warn(`[bridge] exec rejected: invalid user field`);
    sendResult(-1, '', 'Command rejected: invalid user');
    return;
  }

  // Validate cwd if present (prevent path traversal)
  if (cwd && (cwd.includes('..') || !cwd.startsWith('/'))) {
    console.warn(`[bridge] exec rejected: invalid cwd: ${cwd}`);
    sendResult(-1, '', 'Command rejected: invalid cwd');
    return;
  }

  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[bridge] exec: ${command.slice(0, 60)}... (${command.length} bytes)`);
  const child = spawn(args[0], args[1], { ...args[2], detached: true, env: { ...process.env, HOME: `/home/${user || 'root'}` } });

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
    clearTimeout(execTimeout);
    sendResult(code, stdout, stderr);
  });

  // Timeout: kill process group after 5 minutes (negative PID kills entire group)
  const execTimeout = setTimeout(() => {
    // Guard against pid 0/undefined which would kill the bridge's own process group
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
  if (routerWs) try { routerWs.close(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

connectRouter();

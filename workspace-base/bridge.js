#!/usr/bin/env node
// ── Bootstrap Bridge ──────────────────────────────────────────────────────────
// Minimal WS agent for a bare workspace container. Connects to the router,
// receives install/exec/uninstall commands, and executes them locally.
//
// Once the openclaw mini-app is installed and its own bridge.js starts, this
// bridge goes dormant (the router closes the duplicate connection).
//
// Environment (from /etc/openclaw/secrets.env):
//   ROUTER_URL, INSTANCE_ID, INSTANCE_TOKEN, CHAT_ID, PORT, GW_PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
const http = require('http');
const { execSync, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Load secrets from env file
const SECRETS_FILE = '/etc/openclaw/secrets.env';
if (fs.existsSync(SECRETS_FILE)) {
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const ROUTER_URL = process.env.ROUTER_URL || 'https://router.xaiworkspace.com';
const INSTANCE_ID = process.env.INSTANCE_ID || '';
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const PORT = process.env.PORT || '19001';
const HEALTH_PORT = parseInt(process.env.BRIDGE_HEALTH_PORT || '19099', 10);
const HOME = process.env.HOME || '/home/workspace';
const APPS_DIR = path.join(HOME, 'apps');

if (!INSTANCE_ID || !INSTANCE_TOKEN) {
  console.error('[bootstrap] INSTANCE_ID and INSTANCE_TOKEN are required');
  process.exit(1);
}

// Derive WS URL from ROUTER_URL
const wsUrl = ROUTER_URL.replace(/^http/, 'ws') + '/ws/gateway';
const auth = { type: 'gateway_auth', instanceId: INSTANCE_ID, instanceToken: INSTANCE_TOKEN, chatId: CHAT_ID, port: parseInt(PORT, 10) };

let ws = null;
let authenticated = false;
let shuttingDown = false;
let reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 60000;

// ── Check if the app bridge has taken over ──────────────────────────────────
function isAppBridgeRunning() {
  try {
    const list = execSync('pm2 jlist --no-color', { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(list);
    return procs.some(p => p.name === 'bridge' && p.pm2_env?.status === 'online');
  } catch { return false; }
}

// ── WebSocket connection ────────────────────────────────────────────────────
function connect() {
  if (shuttingDown) return;

  // Don't reconnect if the app bridge has taken over
  if (isAppBridgeRunning()) {
    console.log('[bootstrap] App bridge is running — staying dormant');
    setTimeout(connect, 30000); // check again in 30s
    return;
  }

  console.log('[bootstrap] ->', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[bootstrap] Connected, authenticating...');
    ws.send(JSON.stringify(auth));
    reconnectDelay = 3000;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'gateway_auth_ok') {
        console.log('[bootstrap] Authenticated');
        authenticated = true;
        return;
      }
      if (msg.type === 'gateway_auth_error') {
        console.error('[bootstrap] Auth failed:', msg.error);
        return;
      }
      handleMessage(msg);
    } catch (e) {
      console.warn('[bootstrap] Bad message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    authenticated = false;
    console.log(`[bootstrap] Disconnected: ${code} ${reason || ''}`);
    if (!shuttingDown) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    }
  });

  ws.on('error', (err) => {
    console.warn('[bootstrap] WS error:', err.message);
  });
}

// ── Command handlers ────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'install_app': handleInstallApp(msg); break;
    case 'uninstall_app': handleUninstallApp(msg); break;
    case 'restart_app': handleRestartApp(msg); break;
    case 'list_apps': handleListApps(msg); break;
    case 'exec': handleExec(msg); break;
    case 'scan': handleScan(); break;
    default: break;
  }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendProgress(id, slug, stage, percent) {
  send({ type: 'install_progress', id, slug, stage, percent });
}

// ── install_app ─────────────────────────────────────────────────────────────
async function handleInstallApp(msg) {
  const { id, slug, identifier, artifactUrl, sourceUrl, env, manifest } = msg;
  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  console.log(`[bootstrap] Installing app: ${slug} -> ${appDir}`);

  try {
    // 1. Write env vars to secrets.env
    if (env && typeof env === 'object') {
      sendProgress(id, slug, 'configuring', 5);
      const secretsPath = SECRETS_FILE;
      let existing = '';
      try { existing = fs.readFileSync(secretsPath, 'utf8'); } catch {}
      for (const [k, v] of Object.entries(env)) {
        if (!existing.includes(`${k}=`)) {
          fs.appendFileSync(secretsPath, `${k}=${v}\n`);
        }
        process.env[k] = String(v); // also set in current process
      }
    }

    // 2. Download artifact
    sendProgress(id, slug, 'downloading', 10);
    fs.mkdirSync(appDir, { recursive: true });

    if (artifactUrl) {
      const tmpFile = `/tmp/app-${slug}.zip`;
      execSync(`curl -sfL "${artifactUrl}" -o "${tmpFile}"`, { timeout: 60000 });

      sendProgress(id, slug, 'extracting', 30);
      const tmpDir = `/tmp/app-${slug}-extract`;
      execSync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -qo "${tmpFile}" -d "${tmpDir}"`, { timeout: 30000 });

      // Find the inner directory (GitHub archives have a root dir)
      const entries = fs.readdirSync(tmpDir);
      const src = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
        ? path.join(tmpDir, entries[0])
        : tmpDir;

      execSync(`cp -a "${src}/." "${appDir}/"`, { timeout: 15000 });
      execSync(`rm -rf "${tmpFile}" "${tmpDir}"`);
    } else if (sourceUrl) {
      execSync(`git clone --depth 1 "${sourceUrl}" "${appDir}" 2>/dev/null || (cd "${appDir}" && git pull)`, { timeout: 120000 });
    }

    // 3. Run install.sh if present
    sendProgress(id, slug, 'installing', 50);
    const installScript = path.join(appDir, 'scripts', 'install.sh');
    if (fs.existsSync(installScript)) {
      execSync(`bash "${installScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 120000,
        stdio: 'inherit',
      });
    }

    // 4. Install npm deps if package.json exists
    const pkgJson = path.join(appDir, 'package.json');
    if (fs.existsSync(pkgJson) && !fs.existsSync(path.join(appDir, 'node_modules'))) {
      execSync('npm install --omit=dev --loglevel=error', { cwd: appDir, timeout: 60000 });
    }

    // 5. Regenerate ecosystem and restart pm2
    sendProgress(id, slug, 'starting', 80);
    const genScript = path.join(appDir, 'scripts', 'generate-ecosystem.sh');
    if (fs.existsSync(genScript)) {
      execSync(`bash "${genScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 30000,
        stdio: 'inherit',
      });
    }

    const ecoFile = path.join(appDir, 'ecosystem.config.js');
    if (fs.existsSync(ecoFile)) {
      execSync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000, stdio: 'inherit' });
    }

    sendProgress(id, slug, 'complete', 100);
    send({ type: 'install_result', id, slug, status: 'ok' });
    console.log(`[bootstrap] App installed: ${slug}`);
  } catch (err) {
    console.error(`[bootstrap] Install failed for ${slug}:`, err.message);
    send({ type: 'install_result', id, slug, status: 'error', error: err.message });
  }
}

// ── uninstall_app ───────────────────────────────────────────────────────────
function handleUninstallApp(msg) {
  const { id, slug, identifier } = msg;
  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  try {
    // Run uninstall.sh if present
    const uninstallScript = path.join(appDir, 'scripts', 'uninstall.sh');
    if (fs.existsSync(uninstallScript)) {
      execSync(`bash "${uninstallScript}"`, { cwd: appDir, timeout: 30000, stdio: 'inherit' });
    }

    // Stop pm2 processes for this app
    try { execSync(`pm2 delete app-${slug}`, { timeout: 10000 }); } catch {}
    try { execSync(`pm2 delete ${slug}`, { timeout: 10000 }); } catch {}

    // Remove app directory
    execSync(`rm -rf "${appDir}"`, { timeout: 10000 });

    send({ type: 'uninstall_result', id, slug, status: 'ok' });
    console.log(`[bootstrap] App uninstalled: ${slug}`);
  } catch (err) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: err.message });
  }
}

// ── restart_app ─────────────────────────────────────────────────────────────
function handleRestartApp(msg) {
  const { id, slug } = msg;
  try {
    execSync(`pm2 restart ${slug} || pm2 restart app-${slug}`, { timeout: 10000 });
    send({ type: 'restart_result', id, slug, status: 'ok' });
  } catch (err) {
    send({ type: 'restart_result', id, slug, status: 'error', error: err.message });
  }
}

// ── list_apps ───────────────────────────────────────────────────────────────
function handleListApps(msg) {
  const { id } = msg;
  const apps = [];
  try {
    if (fs.existsSync(APPS_DIR)) {
      for (const entry of fs.readdirSync(APPS_DIR)) {
        const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
        if (fs.existsSync(manifestPath)) {
          apps.push({ identifier: entry, installed: true });
        }
      }
    }
  } catch {}
  send({ type: 'list_apps_result', id, apps });
}

// ── exec ────────────────────────────────────────────────────────────────────
function handleExec(msg) {
  const { id, command, cwd, user } = msg;
  if (!command || typeof command !== 'string' || command.length > 10240) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Invalid command' });
    return;
  }

  const { spawn } = require('child_process');
  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  const child = spawn(args[0], args[1], { ...args[2], env: { ...process.env, HOME: `/home/${user || 'workspace'}` } });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => {
    send({ type: 'exec_result', id, code, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) });
  });
}

// ── scan (report installed apps) ────────────────────────────────────────────
function handleScan() {
  handleListApps({ id: 'scan' });
}

// ── Health endpoint ─────────────────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    authenticated,
    instanceId: INSTANCE_ID,
    appBridgeRunning: isAppBridgeRunning(),
  }));
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[bootstrap] Health on :${HEALTH_PORT}`);
});

// ── Startup ─────────────────────────────────────────────────────────────────
connect();

// Graceful shutdown
process.on('SIGINT', () => { shuttingDown = true; ws?.close(); healthServer.close(); });
process.on('SIGTERM', () => { shuttingDown = true; ws?.close(); healthServer.close(); });

// Signal readiness to pm2
if (process.send) process.send('ready');

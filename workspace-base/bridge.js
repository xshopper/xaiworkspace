#!/usr/bin/env node
// ── Workspace Agent ──────────────────────────────────────────────────────────
// Minimal WS agent inside each workspace container. Connects to the router,
// receives install/exec/uninstall commands, and executes them locally.
//
// Once the openclaw mini-app is installed and its own bridge.js starts, this
// agent goes dormant (the router closes the duplicate connection).
//
// Environment (from /etc/openclaw/secrets.env):
//   ROUTER_URL, INSTANCE_ID, INSTANCE_TOKEN, CHAT_ID, PORT, GW_PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
const http = require('http');
const { execSync, execFileSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);
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

// ── Agent version (reported to router; router can trigger self-update) ─────
const AGENT_VERSION = '1.1.0';

// ── Input validation patterns ──────────────────────────────────────────────
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._-]+$/;
const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

if (!INSTANCE_ID || !INSTANCE_TOKEN) {
  console.error('[workspace-agent] INSTANCE_ID and INSTANCE_TOKEN are required');
  process.exit(1);
}

// Derive WS URL from ROUTER_URL
const wsUrl = ROUTER_URL.replace(/^http/, 'ws') + '/ws/gateway';
const auth = { type: 'gateway_auth', instanceId: INSTANCE_ID, instanceToken: INSTANCE_TOKEN, chatId: CHAT_ID, port: parseInt(PORT, 10), agentVersion: AGENT_VERSION };

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

// ── Report installed apps to the router after auth ─────────────────────────
function readManifestVersion(slug) {
  // Scan all directories in ~/apps/ for a manifest.yml matching this slug
  const appsDir = path.join(HOME, 'apps');
  try {
    const dirs = fs.readdirSync(appsDir);
    for (const dir of dirs) {
      const manifestPath = path.join(appsDir, dir, 'manifest.yml');
      try {
        const yaml = fs.readFileSync(manifestPath, 'utf-8');
        const slugMatch = yaml.match(/^slug:\s*['"]?([^\s'"]+)/m);
        if (slugMatch && slugMatch[1] === slug) {
          const verMatch = yaml.match(/^version:\s*['"]?([^\s'"]+)/m);
          return verMatch ? verMatch[1] : null;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function reportInstalledApps() {
  try {
    const list = execSync('pm2 jlist --no-color', { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(list);
    // Filter out system processes — only report installed apps
    const systemProcs = new Set(['bootstrap-bridge', 'bridge', 'updater']);
    const apps = procs
      .filter(p => !systemProcs.has(p.name))
      .map(p => ({
        slug: p.name,
        status: p.pm2_env?.status || 'unknown',
        version: readManifestVersion(p.name),
        restarts: p.pm2_env?.restart_time || 0,
        memory: p.monit?.memory || 0,
        cpu: p.monit?.cpu || 0,
      }));
    if (apps.length > 0 && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'apps_status',
        instanceId: INSTANCE_ID,
        apps,
      }));
      console.log('[workspace-agent] Reported ' + apps.length + ' app(s): ' + apps.map(a => a.slug + ' v' + (a.version || '?') + ' (' + a.status + ')').join(', '));
    }
  } catch (e) {
    console.warn('[workspace-agent] Failed to report apps:', e.message);
  }
}

// ── WebSocket connection ────────────────────────────────────────────────────
function connect() {
  if (shuttingDown) return;

  // Don't reconnect if the app bridge has taken over
  if (isAppBridgeRunning()) {
    console.log('[workspace-agent] App bridge is running — staying dormant');
    setTimeout(connect, 30000); // check again in 30s
    return;
  }

  console.log('[workspace-agent] ->', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[workspace-agent] Connected, authenticating...');
    ws.send(JSON.stringify(auth));
    reconnectDelay = 3000;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'gateway_auth_ok') {
        console.log('[workspace-agent] Authenticated');
        authenticated = true;
        // Report installed apps (pm2 processes) so the router knows what's running
        reportInstalledApps();
        return;
      }
      if (msg.type === 'gateway_auth_error') {
        console.error('[workspace-agent] Auth failed:', msg.error);
        return;
      }
      handleMessage(msg);
    } catch (e) {
      console.warn('[workspace-agent] Bad message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    authenticated = false;
    console.log(`[workspace-agent] Disconnected: ${code} ${reason || ''}`);
    if (!shuttingDown) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    }
  });

  ws.on('error', (err) => {
    console.warn('[workspace-agent] WS error:', err.message);
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

// ── URL validation for app installs ─────────────────────────────────────────
// Only download artifacts and clone source from trusted domains to prevent
// a compromised router from directing the workspace to fetch malicious payloads.
const TRUSTED_DOMAINS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'xaiworkspace.com',
  'router.xaiworkspace.com',
]);

function isUrlTrusted(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return TRUSTED_DOMAINS.has(parsed.hostname)
      || [...TRUSTED_DOMAINS].some(d => parsed.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ── Self-update (slug: 'bootstrap') ────────────────────────────────────────
async function handleSelfUpdate(msg) {
  const { id, version, artifactUrl, sourceUrl, subdir } = msg;
  if (!version || version === AGENT_VERSION) {
    send({ type: 'install_result', id, slug: 'bootstrap', status: 'ok', skipped: true });
    return;
  }

  console.log(`[workspace-agent] Self-update: ${AGENT_VERSION} → ${version}`);

  // Validate URL
  if (artifactUrl && !isUrlTrusted(artifactUrl)) {
    send({ type: 'install_result', id, slug: 'bootstrap', status: 'error', error: 'Untrusted URL' });
    return;
  }
  if (sourceUrl && !isUrlTrusted(sourceUrl)) {
    send({ type: 'install_result', id, slug: 'bootstrap', status: 'error', error: 'Untrusted URL' });
    return;
  }

  const bootstrapDir = '/opt/bootstrap';
  const tmpDir = `/tmp/bootstrap-update-${Date.now()}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    if (artifactUrl) {
      const tmpFile = `${tmpDir}/bootstrap.zip`;
      await execAsync(`curl -sfL "${artifactUrl}" -o "${tmpFile}"`, { timeout: 60000 });
      await execAsync(`unzip -qo "${tmpFile}" -d "${tmpDir}/extract"`, { timeout: 30000 });

      // Find inner directory (GitHub archive root)
      const entries = fs.readdirSync(`${tmpDir}/extract`);
      let src = entries.length === 1 && fs.statSync(path.join(`${tmpDir}/extract`, entries[0])).isDirectory()
        ? path.join(`${tmpDir}/extract`, entries[0])
        : `${tmpDir}/extract`;

      if (subdir) {
        const sub = path.join(src, subdir);
        if (fs.existsSync(sub)) src = sub;
      }

      // Only copy bridge.js — preserve node_modules and ecosystem
      const newBridge = path.join(src, 'bridge.js');
      if (!fs.existsSync(newBridge)) {
        send({ type: 'install_result', id, slug: 'bootstrap', status: 'error', error: 'bridge.js not found in artifact' });
        return;
      }
      fs.copyFileSync(newBridge, path.join(bootstrapDir, 'bridge.js'));
      // Also copy entrypoint.sh and ecosystem if present
      for (const f of ['entrypoint.sh', 'ecosystem.config.js', 'package.json']) {
        const src2 = path.join(src, f);
        if (fs.existsSync(src2)) fs.copyFileSync(src2, path.join(bootstrapDir, f));
      }
    } else if (sourceUrl) {
      await execAsync(`git clone --depth 1 "${sourceUrl}" "${tmpDir}/src"`, { timeout: 120000 });
      let src = `${tmpDir}/src`;
      if (subdir) {
        const sub = path.join(src, subdir);
        if (fs.existsSync(sub)) src = sub;
      }
      const newBridge = path.join(src, 'bridge.js');
      if (!fs.existsSync(newBridge)) {
        send({ type: 'install_result', id, slug: 'bootstrap', status: 'error', error: 'bridge.js not found in source' });
        return;
      }
      fs.copyFileSync(newBridge, path.join(bootstrapDir, 'bridge.js'));
      for (const f of ['entrypoint.sh', 'ecosystem.config.js', 'package.json']) {
        const src2 = path.join(src, f);
        if (fs.existsSync(src2)) fs.copyFileSync(src2, path.join(bootstrapDir, f));
      }
    }

    // Install deps if package.json changed
    const pkgJson = path.join(bootstrapDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      await execAsync('npm install --omit=dev --loglevel=error', { cwd: bootstrapDir, timeout: 60000 });
    }

    send({ type: 'install_result', id, slug: 'bootstrap', status: 'ok' });
    console.log(`[workspace-agent] Self-update complete, restarting...`);

    // Restart via pm2 after a brief delay (let the result message send)
    setTimeout(() => {
      try { execFileSync('pm2', ['restart', 'bootstrap-bridge'], { timeout: 10000 }); }
      catch { process.exit(0); } // fallback: exit and let pm2 auto-restart
    }, 500);
  } catch (err) {
    console.error(`[workspace-agent] Self-update failed:`, err.message);
    send({ type: 'install_result', id, slug: 'bootstrap', status: 'error', error: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── install_app ─────────────────────────────────────────────────────────────
const _installingApps = new Set();
async function handleInstallApp(msg) {
  const { id, slug, identifier, artifactUrl, sourceUrl, subdir, env, manifest } = msg;

  // Self-update: router sends slug 'bootstrap' to upgrade the workspace agent
  if (slug === 'bootstrap') {
    handleSelfUpdate(msg);
    return;
  }

  // Deduplicate — skip if this slug is already being installed
  if (_installingApps.has(slug)) {
    console.log('[workspace-agent] Skipping duplicate install for ' + slug);
    return;
  }
  _installingApps.add(slug);

  // Validate slug before use in shell commands or file paths
  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid slug' });
    return;
  }

  // Validate identifier format to prevent path traversal
  if (identifier && !SAFE_IDENTIFIER.test(identifier)) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  // Verify resolved path stays within APPS_DIR (defense in depth against path traversal)
  if (!path.resolve(appDir).startsWith(path.resolve(APPS_DIR))) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  console.log(`[workspace-agent] Installing app: ${slug} -> ${appDir}`);

  // Validate download URLs against the trusted domain allowlist before proceeding
  if (artifactUrl && !isUrlTrusted(artifactUrl)) {
    const domain = (() => { try { return new URL(artifactUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted artifact URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, status: 'error', error: `Untrusted artifact URL domain: ${domain}` });
    return;
  }
  if (sourceUrl && !isUrlTrusted(sourceUrl)) {
    const domain = (() => { try { return new URL(sourceUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted source URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, status: 'error', error: `Untrusted source URL domain: ${domain}` });
    return;
  }

  try {
    // 1. Write env vars to secrets.env
    const addedKeys = [];
    if (env && typeof env === 'object') {
      sendProgress(id, slug, 'configuring', 5);
      const secretsPath = SECRETS_FILE;
      let existing = '';
      try { existing = fs.readFileSync(secretsPath, 'utf8'); } catch {}
      for (const [k, v] of Object.entries(env)) {
        // Validate env key format (uppercase letters, digits, underscores only)
        if (!VALID_ENV_KEY.test(k)) {
          console.warn(`[workspace-agent] Skipping invalid env key: ${k}`);
          continue;
        }
        // Sanitize value: strip newlines and shell metacharacters that could escape the env file
        const sanitized = String(v).replace(/[\n\r`$\\;|&"']/g, '');
        if (!existing.includes(`${k}=`)) {
          fs.appendFileSync(secretsPath, `${k}=${sanitized}\n`);
          addedKeys.push(k);
        }
        process.env[k] = sanitized;
      }
    }

    // 2. Download artifact
    sendProgress(id, slug, 'downloading', 10);
    fs.mkdirSync(appDir, { recursive: true });

    // Record which env keys this app added so uninstall can clean them up.
    // Written after mkdirSync so appDir is guaranteed to exist.
    if (addedKeys.length > 0) {
      fs.writeFileSync(path.join(appDir, '.env-keys'), addedKeys.join('\n'));
    }

    if (artifactUrl) {
      const tmpFile = `/tmp/app-${slug}-${id.slice(0,8)}.zip`;
      await execAsync(`curl -sfL "${artifactUrl}" -o "${tmpFile}"`, { timeout: 60000 });

      // Verify artifact integrity if SHA-256 hash was provided
      if (msg.sha256) {
        const crypto = require('crypto');
        const fileBuffer = fs.readFileSync(tmpFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (hash !== msg.sha256) {
          send({ type: 'install_result', id, slug, status: 'error', error: `Artifact integrity check failed (expected ${msg.sha256.slice(0, 8)}..., got ${hash.slice(0, 8)}...)` });
          try { fs.unlinkSync(tmpFile); } catch {}
          return;
        }
        console.log(`[workspace-agent] Artifact integrity verified: ${hash.slice(0, 8)}...`);
      }

      sendProgress(id, slug, 'extracting', 30);
      const tmpDir = `/tmp/app-${slug}-${id.slice(0,8)}-extract`;
      await execAsync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -qo "${tmpFile}" -d "${tmpDir}"`, { timeout: 30000 });

      // Find the inner directory (GitHub archives have a root dir)
      const entries = fs.readdirSync(tmpDir);
      let src = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
        ? path.join(tmpDir, entries[0])
        : tmpDir;

      // Navigate to subdir if specified (monorepo: e.g. apps/cliproxy)
      if (subdir) {
        const sub = path.join(src, subdir);
        if (fs.existsSync(sub)) {
          src = sub;
          console.log('[bootstrap] Using subdir: ' + subdir);
        }
      }

      await execAsync(`cp -a "${src}/." "${appDir}/"`, { timeout: 15000 });
      await execAsync(`rm -rf "${tmpFile}" "${tmpDir}"`);
    } else if (sourceUrl) {
      // Convert GitHub tree URLs to sparse checkout
      const ghMatch = sourceUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
      if (ghMatch) {
        const repoUrl = ghMatch[1] + '.git';
        const ghSubdir = ghMatch[3];
        const tmpSparse = '/tmp/sparse-' + slug;
        await execAsync('rm -rf ' + tmpSparse, { timeout: 5000 }).catch(() => {});
        await execAsync('git clone --depth 1 --filter=blob:none --sparse "' + repoUrl + '" ' + tmpSparse, { timeout: 120000 });
        await execAsync('cd ' + tmpSparse + ' && git sparse-checkout set "' + ghSubdir + '"', { timeout: 30000 });
        await execAsync('cp -a ' + tmpSparse + '/' + ghSubdir + '/. ' + appDir + '/', { timeout: 15000 });
        await execAsync('rm -rf ' + tmpSparse, { timeout: 5000 }).catch(() => {});
      } else {
        await execAsync(`git clone --depth 1 "${sourceUrl}" "${appDir}" 2>/dev/null || (cd "${appDir}" && git pull)`, { timeout: 120000 });
      }
    }

    // 3. Run install.sh if present
    sendProgress(id, slug, 'installing', 50);
    const installScript = path.join(appDir, 'scripts', 'install.sh');
    if (fs.existsSync(installScript)) {
      await execAsync(`bash "${installScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 120000,
      });
    }

    // 4. Install deps if package.json exists (using pnpm)
    const pkgJson = path.join(appDir, 'package.json');
    if (fs.existsSync(pkgJson) && !fs.existsSync(path.join(appDir, 'node_modules'))) {
      await execAsync('pnpm install --prod --reporter=silent', { cwd: appDir, timeout: 120000 });
    }

    // 5. Regenerate ecosystem and restart pm2
    sendProgress(id, slug, 'starting', 80);
    const genScript = path.join(appDir, 'scripts', 'generate-ecosystem.sh');
    if (fs.existsSync(genScript)) {
      await execAsync(`bash "${genScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 30000,
      });
    }

    const ecoFile = path.join(appDir, 'ecosystem.config.js');
    if (fs.existsSync(ecoFile)) {
      await execAsync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000 });
    } else if (manifest?.startup) {
      // No ecosystem file — generate one from manifest startup command
      const startupCmd = manifest.startup;
      const eco = 'module.exports = { apps: [{ name: ' + JSON.stringify(slug) + ', script: "/bin/bash", args: ["-c", ' + JSON.stringify(startupCmd) + '], cwd: ' + JSON.stringify(appDir) + ', autorestart: true }] };';
      fs.writeFileSync(ecoFile, eco);
      await execAsync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000 });
      console.log('[bootstrap] Generated ecosystem from manifest.startup for ' + slug);
    }

    sendProgress(id, slug, 'complete', 100);
    send({ type: 'install_result', id, slug, status: 'ok' });
    console.log(`[workspace-agent] App installed: ${slug}`);
  } catch (err) {
    console.error(`[workspace-agent] Install failed for ${slug}:`, err.message);
    send({ type: 'install_result', id, slug, status: 'error', error: err.message });
  } finally {
    _installingApps.delete(slug);
  }
}

// ── uninstall_app ───────────────────────────────────────────────────────────
function handleUninstallApp(msg) {
  const { id, slug, identifier } = msg;

  // Validate slug before use in shell commands
  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid slug' });
    return;
  }

  // Validate identifier format
  if (identifier && !SAFE_IDENTIFIER.test(identifier)) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  // Verify resolved path stays within APPS_DIR
  if (!path.resolve(appDir).startsWith(path.resolve(APPS_DIR))) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  try {
    // Run uninstall.sh if present
    const uninstallScript = path.join(appDir, 'scripts', 'uninstall.sh');
    if (fs.existsSync(uninstallScript)) {
      execSync(`bash "${uninstallScript}"`, { cwd: appDir, timeout: 30000, stdio: 'inherit' });
    }

    // Stop pm2 processes for this app (use execFileSync to avoid shell injection)
    try { execFileSync('pm2', ['delete', `app-${slug}`], { timeout: 10000 }); } catch {}
    try { execFileSync('pm2', ['delete', slug], { timeout: 10000 }); } catch {}

    // Remove app-specific env vars from secrets.env before deleting the directory
    try {
      const envKeysFile = path.join(appDir, '.env-keys');
      if (fs.existsSync(envKeysFile)) {
        const keysToRemove = fs.readFileSync(envKeysFile, 'utf8').split('\n').filter(Boolean);
        if (keysToRemove.length > 0) {
          const secretsPath = SECRETS_FILE;
          let secrets = fs.readFileSync(secretsPath, 'utf8');
          for (const key of keysToRemove) {
            secrets = secrets.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
            delete process.env[key];
          }
          fs.writeFileSync(secretsPath, secrets);
        }
      }
    } catch (e) { console.warn('[workspace-agent] Failed to clean env vars:', e.message); }

    // Remove app directory
    fs.rmSync(appDir, { recursive: true, force: true });

    send({ type: 'uninstall_result', id, slug, status: 'ok' });
    console.log(`[workspace-agent] App uninstalled: ${slug}`);
  } catch (err) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: err.message });
  }
}

// ── restart_app ─────────────────────────────────────────────────────────────
function handleRestartApp(msg) {
  const { id, slug } = msg;

  // Validate slug before use in shell commands
  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'restart_result', id, slug, status: 'error', error: 'Invalid slug' });
    return;
  }

  try {
    // Use execFileSync to avoid shell injection
    try {
      execFileSync('pm2', ['restart', slug], { timeout: 10000 });
    } catch {
      execFileSync('pm2', ['restart', `app-${slug}`], { timeout: 10000 });
    }
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
const MAX_COMMAND_LENGTH = 10240; // 10KB

// Allowlisted command prefixes — only these commands can be executed via the router.
// The workspace container runs user workloads, so this limits what the router can invoke.
const EXEC_ALLOWLIST = [
  'node ',
  'pm2 ',
  'bash scripts/',
  'bash ./scripts/',
  'cat ',
  'ls ',
  'echo ',
  'whoami',
  'hostname',
  'uname ',
  'df ',
  'free ',
  'ps ',
  'npm ',
  'npx ',
  'curl ',
  'tail ',
  'head ',
  'grep ',
  'wc ',
];

function isCommandAllowed(command) {
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

function handleExec(msg) {
  const { id, command, cwd, user } = msg;
  if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid or too long' });
    return;
  }

  // Validate command against allowlist
  if (!isCommandAllowed(command)) {
    console.warn(`[workspace-agent] exec rejected: command not in allowlist: ${command.slice(0, 80)}`);
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: not in allowlist' });
    return;
  }

  // Block the most dangerous shell metacharacters (command chaining and backtick substitution).
  // $(), |, >, < are allowed because the router legitimately uses them in exec commands.
  // The allowlist above is the primary security layer.
  if (/[;`]/.test(command)) {
    console.warn(`[workspace-agent] exec rejected: disallowed shell characters`);
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: disallowed characters' });
    return;
  }

  // Validate user field if present (alphanumeric, underscore, dash only)
  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid user' });
    return;
  }

  // Validate cwd if present (prevent path traversal)
  if (cwd && (cwd.includes('..') || !cwd.startsWith('/'))) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid cwd' });
    return;
  }

  const { spawn } = require('child_process');
  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[workspace-agent] exec: ${command.slice(0, 60)}... (${command.length} bytes)`);
  const child = spawn(args[0], args[1], { ...args[2], detached: true, env: { ...process.env, HOME: `/home/${user || 'workspace'}` } });
  let stdout = '', stderr = '';

  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  child.on('close', code => {
    clearTimeout(execTimeout);
    send({ type: 'exec_result', id, code, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) });
  });

  // Timeout: kill process group after 5 minutes (negative PID kills entire group)
  const execTimeout = setTimeout(() => {
    // Guard against pid 0/undefined which would kill the bridge's own process group
    if (child.pid > 0) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
    send({ type: 'exec_result', id, code: -1, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) + '\nTimeout (300s)' });
  }, 300_000);
}

// ── scan (report installed apps) ────────────────────────────────────────────
function handleScan() {
  const apps = [];
  try {
    if (fs.existsSync(APPS_DIR)) {
      for (const entry of fs.readdirSync(APPS_DIR)) {
        const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
        if (fs.existsSync(manifestPath)) {
          apps.push({ name: entry, status: 'running', health: 'unknown' });
        }
      }
    }
  } catch {}
  send({ type: 'scan_result', instances: apps });
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
  console.log(`[workspace-agent] Health on :${HEALTH_PORT}`);
});

// ── Startup ─────────────────────────────────────────────────────────────────
connect();

// Graceful shutdown
process.on('SIGINT', () => { shuttingDown = true; ws?.close(); healthServer.close(); });
process.on('SIGTERM', () => { shuttingDown = true; ws?.close(); healthServer.close(); });

// Signal readiness to pm2
if (process.send) process.send('ready');

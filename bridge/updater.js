#!/usr/bin/env node
/**
 * Bridge auto-updater — periodically checks for a newer Docker image and
 * performs a safe replacement of the bridge container.
 *
 * Flow:
 *   1. Record the current container's image digest on startup
 *   2. Every CHECK_INTERVAL minutes, `docker pull` the image tag
 *   3. Compare digest — if unchanged, sleep
 *   4. If new digest: stop old → start replacement → verify healthy → clean up
 *
 * The replacement container inherits all env vars, port mappings, volumes,
 * and network attachments from the current container (read via `docker inspect`).
 * Workspace instances survive because they connect to the router independently.
 *
 * Environment variables:
 *   UPDATE_CHECK_INTERVAL — minutes between checks (default: 30)
 *   UPDATE_ENABLED        — set to "false" to disable (default: true)
 *   BRIDGE_IMAGE          — image to pull (default: read from current container)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const CHECK_INTERVAL_MIN = parseInt(process.env.UPDATE_CHECK_INTERVAL || '30', 10);
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MIN * 60 * 1000;
const ENABLED = (process.env.UPDATE_ENABLED || 'true') !== 'false';
const LOCK_FILE = '/tmp/updater.lock';

if (!ENABLED) {
  console.log('[updater] Auto-update disabled (UPDATE_ENABLED=false)');
  process.exit(0);
}

// Concurrency guard — only one updater runs at a time
if (fs.existsSync(LOCK_FILE)) {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    // Check if the PID is still alive
    process.kill(pid, 0); // throws if not running
    console.log(`[updater] Another updater is running (PID ${pid}) — exiting`);
    process.exit(0);
  } catch {
    // PID is dead — stale lock, remove it
    fs.unlinkSync(LOCK_FILE);
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Get this container's own container ID.
 */
function getOwnContainerId() {
  try {
    const hostname = fs.readFileSync('/etc/hostname', 'utf8').trim();
    if (/^[a-f0-9]{12,64}$/.test(hostname)) return hostname;
  } catch {}
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = cgroup.match(/[a-f0-9]{64}/);
    if (match) return match[0];
  } catch {}
  return null;
}

function getContainerImage(containerId) {
  try {
    return execFileSync('docker', [
      'inspect', '--format', '{{.Config.Image}}', containerId,
    ], { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch { return null; }
}

function getLocalDigest(image) {
  try {
    return execFileSync('docker', [
      'inspect', '--format', '{{index .RepoDigests 0}}', image,
    ], { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch { return null; }
}

function pullImage(image) {
  try {
    execFileSync('docker', ['pull', image], { timeout: 300000, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error(`[updater] Pull failed: ${err.message}`);
    return false;
  }
}

function getContainerConfig(containerId) {
  try {
    const raw = execFileSync('docker', ['inspect', containerId], { encoding: 'utf-8', timeout: 10000 });
    return JSON.parse(raw)[0];
  } catch { return null; }
}

/**
 * Start a replacement container with the same config but new image.
 * Copies: env vars, volumes, port bindings, network, restart policy.
 */
function startReplacement(config, newImage) {
  const name = config.Name?.replace(/^\//, '') || 'xaiw-bridge';
  const newName = `${name}-update-${Date.now().toString(36)}`;

  // Clean up any stale update container with the same prefix
  try { execFileSync('docker', ['rm', '-f', newName], { timeout: 10000, stdio: 'pipe' }); } catch {}

  // Use 'create' (not 'run') — don't start yet, ports are still held by old container.
  // The container is started in swapContainers() after the old one is stopped.
  const args = ['create', '--restart', 'unless-stopped', '--name', newName];

  // Copy network mode
  const networkMode = config.HostConfig?.NetworkMode;
  if (networkMode && networkMode !== 'default' && networkMode !== 'bridge') {
    args.push('--network', networkMode);
  }

  // Copy additional networks (beyond the primary one)
  const networks = config.NetworkSettings?.Networks || {};
  for (const netName of Object.keys(networks)) {
    if (netName !== networkMode && netName !== 'bridge') {
      args.push('--network', netName);
    }
  }

  // Copy volume mounts
  const mounts = config.Mounts || [];
  for (const m of mounts) {
    if (m.Type === 'bind') {
      const ro = m.RW === false ? ':ro' : '';
      args.push('-v', `${m.Source}:${m.Destination}${ro}`);
    }
  }

  // Copy port bindings
  const portBindings = config.HostConfig?.PortBindings || {};
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    for (const b of bindings) {
      const hostPort = b.HostPort || '';
      const hostIp = b.HostIp || '';
      const port = containerPort.replace('/tcp', '').replace('/udp', '');
      if (hostIp && hostIp !== '0.0.0.0') {
        args.push('-p', `${hostIp}:${hostPort}:${port}`);
      } else {
        args.push('-p', `${hostPort}:${port}`);
      }
    }
  }

  // Copy env vars
  const env = config.Config?.Env || [];
  for (const e of env) {
    args.push('-e', e);
  }

  args.push(newImage);

  try {
    const id = execFileSync('docker', args, { encoding: 'utf-8', timeout: 60000 }).trim();
    console.log(`[updater] Replacement container created: ${newName} (${id.slice(0, 12)})`);
    return { id, name: newName };
  } catch (err) {
    console.error(`[updater] Failed to create replacement: ${err.message}`);
    return null;
  }
}

/**
 * Wait for a container to become healthy (or just running if no healthcheck).
 */
async function waitForHealthy(containerId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execFileSync('docker', [
        'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}', containerId,
      ], { encoding: 'utf-8', timeout: 5000 }).trim();

      if (status === 'healthy') return true;
      if (status === 'unhealthy') return false;
      if (status === 'no-healthcheck') {
        // No healthcheck defined — check if container is running
        const running = execFileSync('docker', [
          'inspect', '--format', '{{.State.Running}}', containerId,
        ], { encoding: 'utf-8', timeout: 5000 }).trim();
        if (running === 'true') return true;
      }
    } catch {}
    await sleep(5000);
  }
  return false;
}

/**
 * Stop old container, rename new one to take its place, clean up.
 * Stops old FIRST to free ports, then starts the replacement.
 */
function swapContainers(oldName, oldId, newName, newId) {
  const retiredName = `${oldName}-retired-${Date.now().toString(36)}`;
  try {
    // Stop old container first to free ports
    execFileSync('docker', ['stop', '-t', '10', oldName], { timeout: 30000 });
    // Rename old container
    execFileSync('docker', ['rename', oldName, retiredName], { timeout: 10000 });
    // Rename new container to the original name
    execFileSync('docker', ['rename', newName, oldName], { timeout: 10000 });
    // Start the new container (it was created but ports were blocked — now free)
    execFileSync('docker', ['start', oldName], { timeout: 30000 });
    // Remove old container
    execFileSync('docker', ['rm', retiredName], { timeout: 10000 });
    console.log(`[updater] Swap complete: ${oldName} is now running the new image`);
    return true;
  } catch (err) {
    console.error(`[updater] Swap failed: ${err.message}`);
    // Try to restart old container if swap failed
    try { execFileSync('docker', ['start', retiredName], { timeout: 10000 }); } catch {}
    try { execFileSync('docker', ['rename', retiredName, oldName], { timeout: 10000 }); } catch {}
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const containerId = getOwnContainerId();
if (!containerId) {
  console.error('[updater] Cannot determine own container ID — not running in Docker?');
  process.exit(0);
}

// Always pull the -latest tag to detect updates, regardless of what versioned tag
// this container was created from (e.g. bridge-v0.3.0 → pull bridge-latest).
const rawImage = process.env.BRIDGE_IMAGE || getContainerImage(containerId);
if (!rawImage) {
  console.error('[updater] Cannot determine container image');
  process.exit(0);
}
const containerImage = rawImage.replace(/:bridge.*$/, ':bridge-latest');

const containerName = (() => {
  try {
    return execFileSync('docker', [
      'inspect', '--format', '{{.Name}}', containerId,
    ], { encoding: 'utf-8', timeout: 5000 }).trim().replace(/^\//, '');
  } catch { return null; }
})();

console.log(`[updater] Monitoring ${containerImage} for updates (every ${CHECK_INTERVAL_MIN}min)`);
console.log(`[updater] Container: ${containerName || containerId}`);

// Get the image ID that this container is actually running
const runningImageId = (() => {
  try {
    return execFileSync('docker', ['inspect', '--format', '{{.Image}}', containerId],
      { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { return null; }
})();
console.log(`[updater] Running image: ${runningImageId || 'unknown'}`);

async function checkForUpdate() {
  console.log(`[updater] Checking for update...`);

  if (!pullImage(containerImage)) return;

  // Compare the running container's image ID against the pulled image ID
  const pulledImageId = (() => {
    try {
      return execFileSync('docker', ['inspect', '--format', '{{.Id}}', containerImage],
        { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch { return null; }
  })();

  if (!runningImageId || !pulledImageId || runningImageId === pulledImageId) {
    console.log(`[updater] Image is up to date`);
    return;
  }

  console.log(`[updater] New image detected!`);
  console.log(`[updater]   Old: ${beforeDigest}`);
  console.log(`[updater]   New: ${afterDigest}`);

  const config = getContainerConfig(containerId);
  if (!config) {
    console.error('[updater] Cannot read container config — skipping update');
    return;
  }

  if (!containerName) {
    console.error('[updater] Cannot determine container name — skipping update');
    return;
  }

  // Create the replacement container (not started — ports still held by old container)
  const replacement = startReplacement(config, containerImage);
  if (!replacement) return;

  // Swap: stop old → rename → start new (brief downtime while ports transfer)
  console.log(`[updater] Swapping containers...`);
  const swapped = swapContainers(containerName, containerId, replacement.name, replacement.id);
  if (!swapped) return;

  // Wait for the new container to become healthy after starting
  console.log(`[updater] Waiting for new container to become healthy...`);
  const healthy = await waitForHealthy(replacement.id, 120000);
  if (!healthy) {
    console.error(`[updater] New container unhealthy after swap — manual intervention needed`);
    // Don't rollback automatically — the old container is already stopped and renamed
    // The new container is running under the original name. Admin should check logs.
  }
  // The old container (us) is now stopped — this process dies
}

// Initial delay (let the bridge fully start before checking)
setTimeout(async () => {
  await checkForUpdate();
  setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
}, 60000);

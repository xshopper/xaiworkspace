#!/usr/bin/env node
/**
 * Instance Manager — manages workspace containers on the local host.
 *
 * Uses Docker Compose to create/remove/list workspace containers.
 * Each user (chatId) gets their own compose project and file for isolation.
 * The bridge only manages LOCAL containers — AWS provisioning is done by the router.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMPOSE_DIR = process.env.COMPOSE_DIR || '/data';
const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE || 'public.ecr.aws/s3b3q6t2/xaiworkspace-docker:latest';
const NETWORK_NAME = process.env.COMPOSE_NETWORK || 'xai-dev';

// Per-user compose stacks: Map<chatId, Map<instanceId, config>>
const userStacks = new Map();

/** Get or create a user's service map. */
function getUserServices(chatId) {
  if (!userStacks.has(chatId)) userStacks.set(chatId, new Map());
  return userStacks.get(chatId);
}

/** Compose project name for a user. */
function projectName(chatId) {
  // Sanitize chatId for Docker project name (alphanumeric + underscore)
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `xaiworkspace-${safe}`;
}

/** Compose file path for a user. */
function composeFilePath(chatId) {
  return path.join(COMPOSE_DIR, `docker-compose-${chatId.replace(/[^a-zA-Z0-9_-]/g, '')}.yml`);
}

function writeComposeFile(chatId) {
  const services = getUserServices(chatId);
  fs.mkdirSync(COMPOSE_DIR, { recursive: true });
  let yaml = 'services:\n';
  for (const [name, config] of services) {
    yaml += `  ${name}:\n`;
    yaml += `    image: ${config.image || WORKSPACE_IMAGE}\n`;
    yaml += `    container_name: ${name}\n`;
    yaml += `    restart: unless-stopped\n`;
    if (config.env && Object.keys(config.env).length > 0) {
      yaml += '    environment:\n';
      for (const [k, v] of Object.entries(config.env)) yaml += `      - "${k}=${v}"\n`;
    }
    if (config.ports && config.ports.length > 0) {
      yaml += '    ports:\n';
      for (const p of config.ports) yaml += `      - "${p}"\n`;
    }
    if (config.volumes && config.volumes.length > 0) {
      yaml += '    volumes:\n';
      for (const v of config.volumes) yaml += `      - ${v}\n`;
    }
    yaml += '\n';
  }
  yaml += `networks:\n  default:\n    name: ${NETWORK_NAME}\n    external: true\n`;
  const filePath = composeFilePath(chatId);
  fs.writeFileSync(filePath, yaml);
}

function composeUp(chatId) {
  const file = composeFilePath(chatId);
  const project = projectName(chatId);
  try {
    execFileSync('docker', ['compose', '-p', project, '-f', file, 'up', '-d', '--remove-orphans'], {
      stdio: 'inherit', timeout: 60000,
    });
  } catch (err) {
    console.error(`[compose] docker compose up failed for ${chatId}:`, err.message);
  }
}

function addInstance(instanceId, config = {}) {
  const chatId = config.env?.CHAT_ID || 'default';
  const services = getUserServices(chatId);
  services.set(instanceId, {
    image: config.image || WORKSPACE_IMAGE,
    env: config.env || {},
    ports: config.ports || [],
    volumes: config.volumes || [],
  });
  writeComposeFile(chatId);
  composeUp(chatId);
  console.log(`[compose] Added instance: ${instanceId} (stack: ${projectName(chatId)})`);
}

function removeInstance(instanceId) {
  // Find which user stack this instance belongs to
  for (const [chatId, services] of userStacks) {
    if (services.has(instanceId)) {
      services.delete(instanceId);
      writeComposeFile(chatId);
      composeUp(chatId);
      console.log(`[compose] Removed instance: ${instanceId} (stack: ${projectName(chatId)})`);
      return true;
    }
  }
  // Not in any compose stack — try direct docker rm
  try {
    execFileSync('docker', ['rm', '-f', instanceId], { timeout: 15000 });
    console.log(`[compose] Removed standalone instance: ${instanceId}`);
    return true;
  } catch { return false; }
}

function listInstances() {
  const found = new Map(); // name → { name, status, health }

  // 1. Check all per-user compose stacks
  try {
    const files = fs.readdirSync(COMPOSE_DIR).filter(f => f.startsWith('docker-compose-') && f.endsWith('.yml'));
    for (const file of files) {
      const filePath = path.join(COMPOSE_DIR, file);
      // Extract chatId from filename: docker-compose-{chatId}.yml
      const chatId = file.replace('docker-compose-', '').replace('.yml', '');
      const project = projectName(chatId);
      try {
        const output = execFileSync('docker', ['compose', '-p', project, '-f', filePath, 'ps', '--format', 'json'], {
          timeout: 10000,
        }).toString();
        for (const line of output.trim().split('\n').filter(Boolean)) {
          try {
            const c = JSON.parse(line);
            const name = c.Name || c.Service;
            if (name) found.set(name, { name, status: c.State || 'unknown', health: c.Health || '' });
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* COMPOSE_DIR doesn't exist yet */ }

  // 2. Also check legacy single compose file
  const legacyFile = path.join(COMPOSE_DIR, 'docker-compose.yml');
  if (fs.existsSync(legacyFile)) {
    try {
      const output = execFileSync('docker', ['compose', '-p', 'xaiworkspace', '-f', legacyFile, 'ps', '--format', 'json'], {
        timeout: 10000,
      }).toString();
      for (const line of output.trim().split('\n').filter(Boolean)) {
        try {
          const c = JSON.parse(line);
          const name = c.Name || c.Service;
          if (name && !found.has(name)) found.set(name, { name, status: c.State || 'unknown', health: c.Health || '' });
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // 3. Discover orphaned workspace containers (xaiworkspace-w_*) not in any compose
  try {
    const output = execFileSync('docker', [
      'ps', '-a', '--filter', 'name=xaiworkspace-w_', '--format', '{{.Names}} {{.State}}',
    ], { timeout: 10000 }).toString();
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [name, state] = line.split(' ');
      if (name && !found.has(name)) {
        found.set(name, { name, status: state || 'unknown', health: '' });
      }
    }
  } catch { /* ignore */ }

  return Array.from(found.values());
}

module.exports = { addInstance, removeInstance, listInstances };

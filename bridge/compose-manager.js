#!/usr/bin/env node
/**
 * Instance Manager — manages workspace containers on the local host.
 *
 * Uses Docker Compose to create/remove/list workspace containers.
 * The bridge only manages LOCAL containers — AWS provisioning is done by the router.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMPOSE_DIR = process.env.COMPOSE_DIR || '/data';
const COMPOSE_FILE = path.join(COMPOSE_DIR, 'docker-compose.yml');
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'xaiworkspace';
const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE || 'public.ecr.aws/s3b3q6t2/xaiworkspace-docker:latest';
const NETWORK_NAME = process.env.COMPOSE_NETWORK || 'xai-dev';

const services = new Map(); // instanceId → config

function writeComposeFile() {
  fs.mkdirSync(COMPOSE_DIR, { recursive: true });
  let yaml = 'version: "3.8"\n\nservices:\n';
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
  fs.writeFileSync(COMPOSE_FILE, yaml);
}

function composeUp() {
  try {
    execFileSync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'up', '-d', '--remove-orphans'], {
      stdio: 'inherit', timeout: 60000,
    });
  } catch (err) {
    console.error('[compose] docker compose up failed:', err.message);
  }
}

function addInstance(instanceId, config = {}) {
  services.set(instanceId, {
    image: config.image || WORKSPACE_IMAGE,
    env: config.env || {},
    ports: config.ports || [],
    volumes: config.volumes || [],
  });
  writeComposeFile();
  composeUp();
  console.log(`[compose] Added instance: ${instanceId}`);
}

function removeInstance(instanceId) {
  if (!services.has(instanceId)) return false;
  services.delete(instanceId);
  writeComposeFile();
  composeUp();
  console.log(`[compose] Removed instance: ${instanceId}`);
  return true;
}

function listInstances() {
  const found = new Map(); // name → { name, status, health }

  // 1. Check compose-managed containers
  if (fs.existsSync(COMPOSE_FILE)) {
    try {
      const output = execFileSync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', 'json'], {
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

  // 2. Discover orphaned workspace containers (xaiworkspace-w_*) not in compose
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

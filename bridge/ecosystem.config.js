const fs = require('fs');

// Derive ROUTER_WS from ROUTER_URL when not explicitly set.
// ROUTER_URL is always passed (e.g. http://router:8080 in Docker Compose),
// but ROUTER_WS often isn't — so convert http→ws, https→wss and append /ws/gateway.
function deriveRouterWs() {
  if (process.env.ROUTER_WS) return process.env.ROUTER_WS;
  if (process.env.ROUTER_URL) {
    const url = process.env.ROUTER_URL.replace(/\/$/, '');
    const wsUrl = url.replace(/^http/, 'ws');
    return `${wsUrl}/ws/gateway`;
  }
  return 'wss://router.xaiworkspace.com/ws/gateway';
}

// Load AUTH_JSON: env var first, then persisted /data/auth.json (survives restarts).
function loadAuthJson() {
  if (process.env.AUTH_JSON && process.env.AUTH_JSON !== '{}') return process.env.AUTH_JSON;
  try {
    const data = fs.readFileSync('/data/auth.json', 'utf8');
    if (data && data !== '{}') return data;
  } catch { /* not yet registered */ }
  return '{}';
}

module.exports = {
  apps: [
    {
      name: 'pairing-server',
      script: './server.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'bridge',
      script: './bridge.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 3000,
      env: {
        ROUTER_WS: deriveRouterWs(),
        AUTH_JSON: loadAuthJson(),
      },
    },
  ],
};

const fs = require('fs');

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
      name: 'oauth',
      script: './oauth.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'updater',
      script: './updater.js',
      autorestart: false, // runs once per check cycle, exits cleanly on update
      max_restarts: 3,
      restart_delay: 60000,
    },
    {
      name: 'bridge',
      script: './bridge.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 3000,
      env: {
        // bridge.js derives ROUTER_WS from ROUTER_URL if ROUTER_WS is not set
        AUTH_JSON: loadAuthJson(),
      },
    },
  ],
};

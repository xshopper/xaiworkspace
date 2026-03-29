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
        ROUTER_WS: process.env.ROUTER_WS || 'wss://router.xaiworkspace.com/ws/gateway',
        LOCAL_PORT: process.env.LOCAL_PORT || '19001',
        GW_PASSWORD: process.env.GW_PASSWORD || '',
        AUTH_JSON: process.env.AUTH_JSON || '{}',
      },
    },
  ],
};

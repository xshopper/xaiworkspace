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
    },
  ],
};

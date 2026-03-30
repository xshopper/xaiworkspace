module.exports = {
  apps: [{
    name: 'bootstrap-bridge',
    script: '/opt/bootstrap/bridge.js',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    wait_ready: true,
    listen_timeout: 10000,
  }],
};

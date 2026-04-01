#!/bin/bash
set -e

# Write secrets.env from container environment variables
SECRETS_FILE="/etc/openclaw/secrets.env"
mkdir -p /etc/openclaw

echo "# Auto-generated from container env" > "$SECRETS_FILE"
for var in ROUTER_URL INSTANCE_ID INSTANCE_TOKEN CHAT_ID PORT GW_PASSWORD \
           LITELLM_API_KEY LITELLM_BASE_URL; do
  val="${!var}"
  [ -n "$val" ] && echo "${var}=${val}" >> "$SECRETS_FILE"
done
chmod 600 "$SECRETS_FILE"

# Create workspace user home if needed
WORKSPACE_HOME="${HOME:-/home/workspace}"
mkdir -p "$WORKSPACE_HOME/apps"

# Background: patch OpenClaw gateway config after install completes.
# OpenClaw installer overwrites the config, so we patch AFTER it finishes.
(
  OPENCLAW_CONFIG="$WORKSPACE_HOME/.openclaw/openclaw.json"
  # Wait for OpenClaw install to COMPLETE (not just file exists).
  # The installer sets "lastTouchedVersion" in the config when done.
  for i in $(seq 1 120); do
    if [ -f "$OPENCLAW_CONFIG" ] && grep -q 'lastTouchedVersion' "$OPENCLAW_CONFIG" 2>/dev/null; then
      sleep 2  # Extra settle time after install
      break
    fi
    sleep 5
  done
  if [ -f "$OPENCLAW_CONFIG" ]; then
    # Patch gateway.controlUi into the config using node (jq not available)
    OPENCLAW_CONFIG="$OPENCLAW_CONFIG" GW_PASSWORD="$GW_PASSWORD" node -e "
      const fs = require('fs');
      const f = process.env.OPENCLAW_CONFIG;
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg.gateway = cfg.gateway || {};
      cfg.gateway.controlUi = cfg.gateway.controlUi || {};
      cfg.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
      const pw = process.env.GW_PASSWORD;
      if (pw) cfg.gateway.auth = { mode: 'token', token: pw };
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      console.log('[entrypoint] Patched openclaw.json with gateway.controlUi');
    " 2>/dev/null
    # Restart the gateway process so it picks up the new config
    pm2 restart openclaw-gateway 2>/dev/null || true
  fi
) &

echo "[entrypoint] Secrets written, starting workspace agent..."
exec pm2-runtime start /opt/bootstrap/ecosystem.config.js --raw

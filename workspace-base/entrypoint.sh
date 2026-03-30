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

echo "[entrypoint] Secrets written, starting bootstrap bridge..."
exec pm2-runtime start /opt/bootstrap/ecosystem.config.js --raw

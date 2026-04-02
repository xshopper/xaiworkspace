#!/bin/bash
set -e

# Write secrets.env from container environment variables
SECRETS_FILE="/etc/xai/secrets.env"
mkdir -p /etc/xai

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

# Clean up any leftover update/backup temp dirs from previous runs
rm -rf /tmp/bootstrap-update-* /tmp/bootstrap-backup-* /tmp/app-*-backup-* 2>/dev/null || true

echo "[entrypoint] Secrets written, starting workspace agent..."
exec pm2-runtime start /opt/bootstrap/ecosystem.config.js --raw

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

# ── Derive per-user Linux account from CHAT_ID ─────────────────────────────
# The workspace-agent (bridge.js) stays running as root. User apps run under
# a derived non-root user via pm2 uid/gid and su -.
CHAT_ID="${CHAT_ID:-}"
SANITIZED="$(echo "$CHAT_ID" | tr -cd 'a-zA-Z0-9_-' | head -c 28)"
WS_USER="xai${SANITIZED:-default}"
WS_USER="$(echo "$WS_USER" | tr '[:upper:]' '[:lower:]')"
WS_HOME="/home/${WS_USER}"

# Create user (idempotent — skip if exists).
# UID/GID 10000 matches the EFS access point POSIX squash (fsap-*): all
# writes on /home/ appear as 10000:10000 at the filesystem level. Creating
# the Linux user with the same UID/GID makes chown a no-op and lets the
# user actually read/write its own files. Without this, `useradd -m` picks
# a low UID (1000+) and every chown on EFS fails with EPERM.
if ! id "$WS_USER" >/dev/null 2>&1; then
  groupadd -g 10000 "$WS_USER" 2>/dev/null || true
  useradd -m -s /bin/bash -u 10000 -g 10000 "$WS_USER"
  echo "[entrypoint] Created user $WS_USER (uid 10000)"
else
  echo "[entrypoint] User $WS_USER already exists"
fi

# Ensure home directories exist
mkdir -p "$WS_HOME/apps" "$WS_HOME/.openclaw" "$WS_HOME/.npm" "$WS_HOME/.local"

# Copy secrets to user-owned location (mode 600, owned by user).
# On EFS, chown may be squashed to 10000:10000 by the access point — that
# is fine because WS_USER is now also UID 10000. Silencing chown errors
# so the script survives edge cases where the AP rejects same-UID chown.
cp "$SECRETS_FILE" "$WS_HOME/.openclaw/secrets.env"
chown "$WS_USER:$WS_USER" "$WS_HOME/.openclaw/secrets.env" 2>/dev/null || true
chmod 600 "$WS_HOME/.openclaw/secrets.env"

# Set ownership of entire home dir — best effort on EFS.
chown -R "$WS_USER:$WS_USER" "$WS_HOME" 2>/dev/null || true

# Migrate old /home/workspace/ data if it exists and isn't the new home
if [ -d /home/workspace/apps ] && [ "/home/workspace" != "$WS_HOME" ]; then
  echo "[entrypoint] Migrating /home/workspace/ → $WS_HOME/"
  cp -a /home/workspace/apps/. "$WS_HOME/apps/" 2>/dev/null || true
  [ -d /home/workspace/.openclaw ] && cp -a /home/workspace/.openclaw/. "$WS_HOME/.openclaw/" 2>/dev/null || true
  chown -R "$WS_USER:$WS_USER" "$WS_HOME"
  echo "[entrypoint] Migration complete"
fi

# Export for child processes (bridge.js reads these)
export HOME="$WS_HOME"
export WS_USER

# Clean up any leftover update/backup temp dirs from previous runs
rm -rf /tmp/bootstrap-update-* /tmp/bootstrap-backup-* /tmp/app-*-backup-* 2>/dev/null || true

echo "[entrypoint] Secrets written, user=$WS_USER home=$WS_HOME, starting workspace agent..."
export PM2_HOME="$WS_HOME/.pm2"
exec pm2-runtime start /opt/bootstrap/ecosystem.config.js --raw

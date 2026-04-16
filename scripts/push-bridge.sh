#!/usr/bin/env bash
# push-bridge.sh — Build and push multi-arch bridge image to ECR, then notify routers.
#
# Builds linux/amd64 + linux/arm64 in a single buildx invocation and pushes a
# multi-arch manifest. First run auto-provisions a buildx builder and installs
# QEMU binfmt handlers so arm64 can be built on amd64 hosts (and vice versa).
#
# Usage:
#   ./scripts/push-bridge.sh              # build + push bridge-latest + bridge-vX.Y.Z (multi-arch)
#
# Environment:
#   ECR_WEBHOOK_SECRET  — HMAC secret for router webhook (optional, skips notification if unset)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ECR_REPO="public.ecr.aws/s3b3q6t2/xaiworkspace-docker"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER_NAME="xaiw-bridge-builder"

VERSION=$(node -e "console.log(require('$REPO_DIR/bridge/package.json').version)")
echo "Bridge version: $VERSION"

# Pre-flight: verify ECR Public credentials are present. Building multi-arch under QEMU
# takes minutes — we fail fast here rather than after a long build.
if ! node -e "
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cfg = path.join(os.homedir(), '.docker', 'config.json');
  if (!fs.existsSync(cfg)) process.exit(1);
  const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const auths = j.auths || {};
  if (auths['public.ecr.aws']) process.exit(0);
  // credsStore/credHelpers can also provide auth — accept if configured
  if ((j.credHelpers && j.credHelpers['public.ecr.aws']) || j.credsStore) process.exit(0);
  process.exit(1);
" >/dev/null 2>&1; then
  cat >&2 <<EOF
ERROR: No Docker credentials found for public.ecr.aws.
Log in first:
  aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
EOF
  exit 1
fi

# QEMU binfmt handlers live in /proc and do not persist across host reboots — check
# independently of the buildx builder (which is just a CLI config entry and does persist).
if ! [ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  echo "Registering QEMU binfmt handlers for cross-arch builds..."
  docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64 >/dev/null
fi

# Ensure buildx builder with docker-container driver (required for multi-arch + --push)
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  echo "Creating buildx builder: $BUILDER_NAME"
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
fi

# Build + push multi-arch in one step (buildx can't load multi-arch into local daemon).
# Using --builder instead of `buildx use` so we don't mutate the user's default builder.
echo "Building and pushing multi-arch bridge image ($PLATFORMS)..."
METADATA_FILE=$(mktemp)
trap 'rm -f "$METADATA_FILE"' EXIT

docker buildx build \
  --builder "$BUILDER_NAME" \
  --platform "$PLATFORMS" \
  -f "$REPO_DIR/Dockerfile.bridge" \
  -t "$ECR_REPO:bridge-latest" \
  -t "$ECR_REPO:bridge-v$VERSION" \
  --metadata-file "$METADATA_FILE" \
  --push \
  "$REPO_DIR"

echo "Pushed: bridge-latest, bridge-v$VERSION"

# Extract manifest digest from buildx metadata
DIGEST=$(node -e "try { console.log(require('$METADATA_FILE')['containerimage.digest'] || '') } catch(e) { console.log('') }")
echo "Digest: ${DIGEST:-<unknown>}"

# Notify routers
if [[ -z "${ECR_WEBHOOK_SECRET:-}" ]]; then
  echo "ECR_WEBHOOK_SECRET not set — skipping router notification"
  exit 0
fi

ROUTERS=(
  "https://dev001.xaiworkspace.com"
  "https://test-router.xaiworkspace.com"
  "https://router.xaiworkspace.com"
)

BODY=$(node -e "console.log(JSON.stringify({image:'$ECR_REPO',tag:'bridge-latest',version:'$VERSION',digest:'$DIGEST',timestamp:new Date().toISOString()}))")
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$ECR_WEBHOOK_SECRET" | awk '{print $NF}')"

for ROUTER in "${ROUTERS[@]}"; do
  echo -n "Notifying $ROUTER... "
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$ROUTER/api/webhooks/ecr-push" \
    -H "Content-Type: application/json" \
    -H "x-ecr-signature: $SIG" \
    -d "$BODY" \
    --max-time 10 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "OK"
  else
    echo "FAILED ($HTTP_CODE)"
  fi
done

echo "Done."

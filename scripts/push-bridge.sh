#!/usr/bin/env bash
# push-bridge.sh — Build, push bridge image to ECR, and notify routers.
#
# Usage:
#   ./scripts/push-bridge.sh              # push bridge-latest + bridge-vX.Y.Z
#   ./scripts/push-bridge.sh --skip-build  # push only (image already built)
#
# Environment:
#   ECR_WEBHOOK_SECRET  — HMAC secret for router webhook (optional, skips notification if unset)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ECR_REPO="public.ecr.aws/s3b3q6t2/xaiworkspace-docker"

# Read version from package.json
VERSION=$(node -e "console.log(require('$REPO_DIR/bridge/package.json').version)")
echo "Bridge version: $VERSION"

# Build unless --skip-build
if [[ "${1:-}" != "--skip-build" ]]; then
  echo "Building bridge image..."
  docker build -f "$REPO_DIR/Dockerfile.bridge" \
    -t xaiworkspace-bridge:latest \
    -t "xaiworkspace-bridge:v$VERSION" \
    "$REPO_DIR"
fi

# Tag and push
echo "Pushing to ECR..."
docker tag xaiworkspace-bridge:latest "$ECR_REPO:bridge-latest"
docker tag "xaiworkspace-bridge:v$VERSION" "$ECR_REPO:bridge-v$VERSION"
docker push "$ECR_REPO:bridge-latest"
docker push "$ECR_REPO:bridge-v$VERSION"
echo "Pushed: bridge-latest, bridge-v$VERSION"

# Get digest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$ECR_REPO:bridge-latest" 2>/dev/null | cut -d@ -f2 || echo "")

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

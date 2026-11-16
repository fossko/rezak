#!/usr/bin/env bash
# Build the app locally and upload dist/ to a static host over SSH/rsync.
#
#   CARVER_HOST=user@your-host.example deploy/ship.sh
#   CARVER_HOST=user@your-host.example deploy/ship.sh --models
#
# Required environment:
#   CARVER_HOST  SSH destination, e.g. user@host
# Optional:
#   CARVER_KEY   private key path; without it, use your ~/.ssh/config or an agent
#   CARVER_DEST  remote directory (default /srv/rezak/current)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CARVER_HOST:?Set CARVER_HOST=user@host (see deploy/README or docs/DEPLOYMENT.md)}"
DEST="${CARVER_DEST:-/srv/rezak/current}"
SSH="${CARVER_SSH:-ssh}"
if [ -n "${CARVER_KEY:-}" ]; then
  SSH="ssh -i $CARVER_KEY -o IdentitiesOnly=yes"
fi

echo "→ Build"
npm run build

echo "→ dist/ → $CARVER_HOST:$DEST/dist/"
rsync -a --delete -e "$SSH" dist/ "$CARVER_HOST:$DEST/dist/"

if [ "${1:-}" = "--models" ]; then
  [ -d models ] || { echo "✗ no models/ — populate it with: node deploy/sync-models.mjs"; exit 1; }
  echo "→ models/ → $CARVER_HOST:$DEST/models/"
  rsync -a -e "$SSH" models/ "$CARVER_HOST:$DEST/models/"
fi

echo "✓ Uploaded ($(git rev-parse --short HEAD 2>/dev/null || echo 'no git'))"

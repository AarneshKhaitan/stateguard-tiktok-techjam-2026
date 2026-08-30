#!/usr/bin/env bash
# Windows-compatible replacement for `npm run poc`.
#
# scripts/start-local-poc.sh is POSIX-only (id -u, uname -s) and does not run on
# Windows. This sets the same environment it would set, minus the POSIX bits, and
# starts the built server. Verified working end-to-end on Windows + Docker Desktop.
#
# Prereqs (one time):
#   docker build --file Dockerfile.runtime \
#     --build-arg "RUNTIME_APT_PACKAGES=ca-certificates git ripgrep" \
#     --tag volc-agent-runtime:local .
#   npm run build     # via PowerShell, not Git Bash
#
# Then: bash run-local.sh   ->   http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env; set +a

export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3000

export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE=docker
export CONTAINER_RUNTIME_IMAGE=volc-agent-runtime:local
# process.getuid() is undefined on Windows so config.ts would default to 1000:1000
# anyway; set it explicitly so the value is visible rather than implied.
export CONTAINER_USER=1000:1000
# Landlock verified available inside the runtime image, so keep the stronger mode.
# The starter's own probe false-negatives here because it never mounts /codex-home.
export CODEX_SANDBOX_MODE=workspace-write
export RUNTIME_INSTANCE_ID=p0

export APP_DATA_DIR=.local/data
export AGENT_WORKSPACE_ROOT=.local/workspaces
export CODEX_HOME=.local/codex-home
mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"

exec node apps/server/dist/index.js

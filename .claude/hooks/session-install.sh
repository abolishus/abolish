#!/usr/bin/env bash
# SessionStart (asynchronous): install workspace dependencies with Vite+.
# Runs in the background so a slow install never blocks the session; wait for
# node_modules/.modules.yaml before running tests early in a session.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"

if ! command -v vp >/dev/null 2>&1; then
  echo "[session-install] vp not found; install Vite+ (https://viteplus.dev)" >&2
  exit 0
fi
vp env on >/dev/null 2>&1 || true
vp install --frozen-lockfile

#!/usr/bin/env bash
# SessionStart (synchronous): local services for development and tests.
# Idempotent; safe on startup, resume, clear and compact.
#   - Postgres: role "abolish", databases abolish_dev and abolish_test
#   - Redis (Dragonfly-compatible protocol) on 6379, no persistence
#   - Vite+ managed mode so node/pnpm match .node-version and devEngines
# Dependency install runs separately and asynchronously (session-install.sh).
set -euo pipefail

# Development sessions only: the review workflows run Claude Code in CI, where
# these services and installs are neither wanted nor allowed.
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then exit 0; fi

log() { echo "[session-start] $*" >&2; }

PG_USER=abolish
PG_PASSWORD=abolish
PG_DATABASES=(abolish_dev abolish_test)

as_postgres() {
  if [ "$(id -u)" = "0" ] && command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

start_postgres() {
  if pg_isready -q -h localhost -p 5432 2>/dev/null; then
    return 0
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    local version
    version=$(pg_lsclusters --no-header 2>/dev/null | awk 'NR==1 {print $1}')
    if [ -n "$version" ]; then
      pg_ctlcluster "$version" main start || true
    fi
  elif command -v service >/dev/null 2>&1; then
    service postgresql start || true
  fi
  for _ in $(seq 1 30); do
    pg_isready -q -h localhost -p 5432 2>/dev/null && return 0
    sleep 1
  done
  log "postgres did not become ready"
  return 1
}

ensure_databases() {
  # Peer auth over the local socket as the postgres superuser.
  as_postgres psql -v ON_ERROR_STOP=1 -qtA -d postgres >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}' CREATEDB;
  END IF;
END \$\$;
SQL
  for db in "${PG_DATABASES[@]}"; do
    if ! as_postgres psql -qtA -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -q 1; then
      as_postgres createdb -O "$PG_USER" "$db"
      log "created database $db"
    fi
  done
}

start_redis() {
  if redis-cli -p 6379 ping >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v redis-server >/dev/null 2>&1; then
    log "redis-server not installed"
    return 1
  fi
  redis-server --port 6379 --daemonize yes --save "" --appendonly no >/dev/null
  for _ in $(seq 1 20); do
    redis-cli -p 6379 ping >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  log "redis did not become ready"
  return 1
}

persist_env() {
  local shims="$HOME/.local/share/vite-plus/bin"
  if command -v vp >/dev/null 2>&1; then
    vp env on >/dev/null 2>&1 || true
  fi
  [ -n "${CLAUDE_ENV_FILE:-}" ] || return 0
  {
    echo "export PATH=\"$shims:\$PATH\""
    echo "export DATABASE_URL=\"postgres://${PG_USER}:${PG_PASSWORD}@localhost:5432/abolish_dev\""
    echo "export TEST_DATABASE_URL=\"postgres://${PG_USER}:${PG_PASSWORD}@localhost:5432/abolish_test\""
    echo "export REDIS_URL=\"redis://localhost:6379\""
  } >>"$CLAUDE_ENV_FILE"
}

status=0
start_postgres && ensure_databases || status=1
start_redis || status=1
persist_env
if [ "$status" -ne 0 ]; then
  log "some services failed to start; see messages above"
fi
# Never block the session on a service failure: tests that need it will say so.
exit 0

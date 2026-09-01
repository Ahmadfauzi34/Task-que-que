#!/data/data/com.termux/files/usr/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
RUST_PID=""
BUN_PID=""
CF_PID=""
RUST_LOG="$TMP_DIR/rust.log"
BUN_LOG="$TMP_DIR/gateway.log"
CF_LOG="$TMP_DIR/cloudflared.log"
RUST_BIN="${TASK_QUEUE_RUST_BIN:-robust-sinkhorn-queue}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-task-queue-bun}"
CLOUDFLARED_BIN="${TASK_QUEUE_CLOUDFLARED_BIN:-cloudflared}"
TOKEN="trycloudflare-proof-$$-$(date +%s)"
IDEMPOTENCY_KEY="trycloudflare-idempotency-$$"

print_logs() {
  if [ -s "$RUST_LOG" ]; then
    printf '\n--- Rust daemon log ---\n' >&2
    cat "$RUST_LOG" >&2 || true
  fi
  if [ -s "$BUN_LOG" ]; then
    printf '\n--- Bun gateway log ---\n' >&2
    cat "$BUN_LOG" >&2 || true
  fi
  if [ -s "$CF_LOG" ]; then
    printf '\n--- cloudflared log ---\n' >&2
    cat "$CF_LOG" >&2 || true
  fi
}

fail() {
  printf 'trycloudflare smoke error: %s\n' "$*" >&2
  print_logs
  exit 1
}

cleanup() {
  if [ -n "$CF_PID" ]; then
    kill "$CF_PID" >/dev/null 2>&1 || true
    wait "$CF_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$BUN_PID" ]; then
    kill "$BUN_PID" >/dev/null 2>&1 || true
    wait "$BUN_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$RUST_PID" ]; then
    kill "$RUST_PID" >/dev/null 2>&1 || true
    wait "$RUST_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_executable() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  [ -x "$1" ] || fail "required executable not found: $1"
}

wait_for_url() {
  url="$1"
  attempts=0
  while [ "$attempts" -lt 120 ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  return 1
}

extract_public_origin() {
  sed -n 's#.*\(https://[A-Za-z0-9-][A-Za-z0-9-]*\.trycloudflare\.com\).*#\1#p' "$CF_LOG" | sed -n '1p'
}

require_command curl
require_command grep
require_command sed
require_command mktemp
require_command date
require_executable "$RUST_BIN"
require_executable "$BUN_BIN"
require_executable "$CLOUDFLARED_BIN"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; physical reference proof targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found at /system/bin/linker64"

# Cloudflare documents that Quick Tunnels are incompatible with a local config file.
if [ -f "$HOME/.cloudflared/config.yaml" ] || [ -f "$HOME/.cloudflared/config.yml" ]; then
  fail "Quick Tunnel cannot run while ~/.cloudflared/config.yaml or config.yml exists; move it aside for this isolated proof"
fi

if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "port 7331 already has a queue daemon; stop it before running the isolated proof"
fi
if curl -fsS --max-time 1 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
  fail "port 3000 already has a gateway; stop it before running the isolated proof"
fi

RUST_VERSION="$("$RUST_BIN" version 2>/dev/null || true)"
[ -n "$RUST_VERSION" ] || fail "Rust queue binary could not execute"
BUN_VERSION="$("$BUN_BIN" --version 2>/dev/null || true)"
[ -n "$BUN_VERSION" ] || fail "Bun Android runtime could not execute"
CF_VERSION="$("$CLOUDFLARED_BIN" --version 2>/dev/null || true)"
[ -n "$CF_VERSION" ] || fail "cloudflared could not execute"

printf 'TryCloudflare + Termux public reference proof\n'
printf 'architecture : %s\n' "$ARCH"
printf 'rust binary  : %s\n' "$RUST_VERSION"
printf 'bun runtime  : %s\n' "$BUN_VERSION"
printf 'cloudflared  : %s\n' "$CF_VERSION"

"$RUST_BIN" serve --db "$TMP_DIR/queue.db" >"$RUST_LOG" 2>&1 &
RUST_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" || fail "Rust queue daemon readiness failed"
kill -0 "$RUST_PID" >/dev/null 2>&1 || fail "Rust queue daemon exited after readiness"

(
  cd "$ROOT_DIR/gateway"
  exec env \
    GATEWAY_API_TOKEN="$TOKEN" \
    GATEWAY_ENQUEUE_RATE_PER_SECOND=10000 \
    GATEWAY_ENQUEUE_BURST=100000 \
    "$BUN_BIN" run src/server.ts
) >"$BUN_LOG" 2>&1 &
BUN_PID=$!
wait_for_url "http://127.0.0.1:3000/readyz" || fail "Bun gateway readiness failed"
kill -0 "$BUN_PID" >/dev/null 2>&1 || fail "Bun gateway exited after readiness"

"$CLOUDFLARED_BIN" tunnel --url http://127.0.0.1:3000 >"$CF_LOG" 2>&1 &
CF_PID=$!

PUBLIC_ORIGIN=""
attempts=0
while [ "$attempts" -lt 120 ]; do
  PUBLIC_ORIGIN="$(extract_public_origin)"
  if [ -n "$PUBLIC_ORIGIN" ]; then
    break
  fi
  if ! kill -0 "$CF_PID" >/dev/null 2>&1; then
    fail "cloudflared exited before publishing a Quick Tunnel URL"
  fi
  attempts=$((attempts + 1))
  sleep 0.25
done
[ -n "$PUBLIC_ORIGIN" ] || fail "cloudflared did not publish a trycloudflare.com URL"
wait_for_url "$PUBLIC_ORIGIN/healthz" || fail "public Quick Tunnel did not reach Bun gateway health"
kill -0 "$CF_PID" >/dev/null 2>&1 || fail "cloudflared exited after public health became reachable"

printf 'public origin: %s\n' "$PUBLIC_ORIGIN"

TASK_BODY='{"type":"document.process","payload":{"document_id":"trycloudflare-physical-proof"},"priority":10,"max_retries":3}'

unauthorized_status="$(
  curl -sS --max-time 15 -o "$TMP_DIR/unauthorized.json" -w '%{http_code}' \
    -X POST "$PUBLIC_ORIGIN/v1/tasks" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: unauthorized-$IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
[ "$unauthorized_status" = "401" ] || fail "public request without bearer token returned HTTP $unauthorized_status instead of 401"

created="$(
  curl -fsS --max-time 20 \
    -X POST "$PUBLIC_ORIGIN/v1/tasks" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)" || fail "authenticated public enqueue failed"
printf '%s' "$created" | grep -F '"status":"PENDING"' >/dev/null || fail "authenticated public task was not accepted as PENDING"
printf '%s' "$created" | grep -F '"replayed":false' >/dev/null || fail "first public idempotent enqueue was not marked created"
TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[ "$TASK_ID" = "1" ] || fail "expected first authenticated task_id=1 after rejected unauthorized request; got '${TASK_ID:-missing}'"

replayed="$(
  curl -fsS --max-time 20 \
    -X POST "$PUBLIC_ORIGIN/v1/tasks" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)" || fail "authenticated public replay failed"
printf '%s' "$replayed" | grep -F '"task_id":1' >/dev/null || fail "public replay returned a different task id"
printf '%s' "$replayed" | grep -F '"replayed":true' >/dev/null || fail "public replay was not marked replayed"

conflict_status="$(
  curl -sS --max-time 15 -o "$TMP_DIR/conflict.json" -w '%{http_code}' \
    -X POST "$PUBLIC_ORIGIN/v1/tasks" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary '{"type":"document.process","payload":{"document_id":"changed"},"priority":10,"max_retries":3}'
)"
[ "$conflict_status" = "409" ] || fail "public idempotency conflict returned HTTP $conflict_status instead of 409"

snapshot="$(
  curl -fsS --max-time 20 "$PUBLIC_ORIGIN/v1/tasks/1" \
    -H "Authorization: Bearer $TOKEN"
)" || fail "authenticated public task query failed"
printf '%s' "$snapshot" | grep -F '"task_name":"document.process"' >/dev/null || fail "public snapshot lost task name"
printf '%s' "$snapshot" | grep -F '"task_type":"cpu"' >/dev/null || fail "registry mapping was not preserved through TryCloudflare"
if printf '%s' "$snapshot" | grep -F '"payload"' >/dev/null; then
  fail "public snapshot leaked payload"
fi

[ -s "$TMP_DIR/queue.db" ] || fail "SQLite queue database was not created"

printf '\nProof state\n'
printf 'Android ARM64 runtime             : OK\n'
printf 'Rust loopback daemon readiness     : OK\n'
printf 'Bun bearer auth boundary           : OK\n'
printf 'cloudflared outbound tunnel        : OK\n'
printf 'public unauthenticated -> 401      : OK\n'
printf 'public authenticated enqueue       : OK (task_id=1)\n'
printf 'public durable replay              : OK (same task_id)\n'
printf 'public idempotency conflict -> 409 : OK\n'
printf 'registry mapping                   : OK (document.process -> cpu)\n'
printf 'public payload non-disclosure      : OK\n'
printf 'SQLite persistence                 : OK\n'
printf '\nTryCloudflare -> Bun bearer -> Rust integration: OK\n'

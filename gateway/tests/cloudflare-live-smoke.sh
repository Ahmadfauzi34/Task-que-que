#!/data/data/com.termux/files/usr/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
RUST_PID=""
BUN_PID=""
RUST_LOG="$TMP_DIR/rust.log"
BUN_LOG="$TMP_DIR/gateway.log"
RUST_BIN="${TASK_QUEUE_RUST_BIN:-robust-sinkhorn-queue}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-task-queue-bun}"

fail() {
  printf 'cloudflare live smoke error: %s\n' "$*" >&2
  if [ -s "$RUST_LOG" ]; then
    printf '\n--- Rust daemon log ---\n' >&2
    cat "$RUST_LOG" >&2 || true
  fi
  if [ -s "$BUN_LOG" ]; then
    printf '\n--- Bun gateway log ---\n' >&2
    cat "$BUN_LOG" >&2 || true
  fi
  exit 1
}

cleanup() {
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

require_env() {
  name="$1"
  eval "value=\${$name-}"
  [ -n "$value" ] || fail "required environment variable is missing: $name"
}

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
  log_file="$2"
  attempts=0
  while [ "$attempts" -lt 100 ]; do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'service did not become ready: %s\n' "$url" >&2
  cat "$log_file" >&2 || true
  return 1
}

public_status() {
  output_file="$1"
  shift
  curl -sS --max-time 15 -o "$output_file" -w '%{http_code}' "$@"
}

require_env CF_PUBLIC_ORIGIN
require_env CF_ACCESS_CLIENT_ID
require_env CF_ACCESS_CLIENT_SECRET
require_env GATEWAY_CF_ACCESS_TEAM_DOMAIN
require_env GATEWAY_CF_ACCESS_AUD
require_command curl
require_command grep
require_command sed
require_command mktemp
require_executable "$RUST_BIN"
require_executable "$BUN_BIN"

case "$CF_PUBLIC_ORIGIN" in
  https://*) ;;
  *) fail "CF_PUBLIC_ORIGIN must start with https://" ;;
esac
case "$CF_PUBLIC_ORIGIN" in
  */) CF_PUBLIC_ORIGIN="${CF_PUBLIC_ORIGIN%/}" ;;
esac
case "$CF_PUBLIC_ORIGIN" in
  *'/'*)
    origin_tail="${CF_PUBLIC_ORIGIN#https://}"
    case "$origin_tail" in
      */*) fail "CF_PUBLIC_ORIGIN must be an HTTPS origin without a path" ;;
    esac
    ;;
esac

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; live reference proof targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found at /system/bin/linker64"

if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "port 7331 already has a queue daemon; stop it before running the isolated live proof"
fi
if curl -fsS --max-time 1 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
  fail "port 3000 already has a gateway; stop it before running the isolated live proof"
fi

RUST_VERSION="$("$RUST_BIN" version 2>/dev/null || true)"
[ -n "$RUST_VERSION" ] || fail "Rust queue binary could not execute"
BUN_VERSION="$("$BUN_BIN" --version 2>/dev/null || true)"
[ -n "$BUN_VERSION" ] || fail "Bun Android runtime could not execute"

printf 'Cloudflare + Termux public boundary proof\n'
printf 'architecture : %s\n' "$ARCH"
printf 'rust binary  : %s\n' "$RUST_VERSION"
printf 'bun runtime  : %s\n' "$BUN_VERSION"
printf 'public origin: %s\n' "$CF_PUBLIC_ORIGIN"

"$RUST_BIN" serve --db "$TMP_DIR/queue.db" >"$RUST_LOG" 2>&1 &
RUST_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" "$RUST_LOG" || fail "Rust queue daemon readiness failed"

(
  cd "$ROOT_DIR/gateway"
  exec env \
    GATEWAY_AUTH_MODE=cloudflare_access_service \
    GATEWAY_CF_ACCESS_TEAM_DOMAIN="$GATEWAY_CF_ACCESS_TEAM_DOMAIN" \
    GATEWAY_CF_ACCESS_AUD="$GATEWAY_CF_ACCESS_AUD" \
    GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID="$CF_ACCESS_CLIENT_ID" \
    GATEWAY_ENQUEUE_RATE_PER_SECOND=10000 \
    GATEWAY_ENQUEUE_BURST=100000 \
    "$BUN_BIN" run src/server.ts
) >"$BUN_LOG" 2>&1 &
BUN_PID=$!
wait_for_url "http://127.0.0.1:3000/healthz" "$BUN_LOG" || fail "Bun gateway liveness failed"
kill -0 "$BUN_PID" >/dev/null 2>&1 || fail "Bun gateway exited after liveness"

TASK_BODY='{"type":"document.process","payload":{"document_id":"cloudflare-live-proof"},"priority":10,"max_retries":3}'
IDEMPOTENCY_KEY="cf-live-$$"

# A forged Cloudflare-looking assertion sent directly to loopback must not be trusted.
local_spoof_status="$(
  curl -sS --max-time 10 -o "$TMP_DIR/local-spoof.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZvcmdlZCJ9.eyJhdWQiOlsiZm9yZ2VkIl19.Zm9yZ2Vk' \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: local-spoof-$IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
[ "$local_spoof_status" = "401" ] || fail "direct localhost forged Access JWT returned HTTP $local_spoof_status instead of 401"

# Missing Access credentials must not enqueue through the public hostname.
public_unauth_status="$(
  public_status "$TMP_DIR/public-unauth.json" \
    -X POST "$CF_PUBLIC_ORIGIN/v1/tasks" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: public-unauth-$IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
case "$public_unauth_status" in
  2*) fail "public request without Access credentials unexpectedly returned HTTP $public_unauth_status" ;;
esac

# A deliberately wrong secret must also fail at the Access boundary.
wrong_secret_status="$(
  public_status "$TMP_DIR/public-wrong-secret.json" \
    -X POST "$CF_PUBLIC_ORIGIN/v1/tasks" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H 'CF-Access-Client-Secret: deliberately-invalid-secret' \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: wrong-secret-$IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
case "$wrong_secret_status" in
  2*) fail "public request with wrong Access secret unexpectedly returned HTTP $wrong_secret_status" ;;
esac

created="$(
  curl -fsS --max-time 20 \
    -X POST "$CF_PUBLIC_ORIGIN/v1/tasks" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)" || fail "authenticated public enqueue failed"
printf '%s' "$created" | grep -F '"status":"PENDING"' >/dev/null || fail "authenticated public task was not accepted as PENDING"
printf '%s' "$created" | grep -F '"replayed":false' >/dev/null || fail "first public idempotent enqueue was not marked created"
TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[ "$TASK_ID" = "1" ] || fail "expected first accepted task_id=1 after rejected spoof/unauthorized attempts; got '${TASK_ID:-missing}'"

replayed="$(
  curl -fsS --max-time 20 \
    -X POST "$CF_PUBLIC_ORIGIN/v1/tasks" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)" || fail "authenticated public replay failed"
printf '%s' "$replayed" | grep -F '"task_id":1' >/dev/null || fail "public replay returned a different task id"
printf '%s' "$replayed" | grep -F '"replayed":true' >/dev/null || fail "public replay was not marked replayed"

conflict_status="$(
  public_status "$TMP_DIR/public-conflict.json" \
    -X POST "$CF_PUBLIC_ORIGIN/v1/tasks" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary '{"type":"document.process","payload":{"document_id":"changed"},"priority":10,"max_retries":3}'
)"
[ "$conflict_status" = "409" ] || fail "public idempotency conflict returned HTTP $conflict_status instead of 409"

snapshot="$(
  curl -fsS --max-time 20 "$CF_PUBLIC_ORIGIN/v1/tasks/1" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
)" || fail "authenticated public task query failed"
printf '%s' "$snapshot" | grep -F '"task_name":"document.process"' >/dev/null || fail "public snapshot lost task name"
printf '%s' "$snapshot" | grep -F '"task_type":"cpu"' >/dev/null || fail "registry mapping was not preserved through Cloudflare"
if printf '%s' "$snapshot" | grep -F '"payload"' >/dev/null; then
  fail "public snapshot leaked payload"
fi

[ -s "$TMP_DIR/queue.db" ] || fail "SQLite queue database was not created"

printf '\nProof state\n'
printf 'Android ARM64 runtime             : OK\n'
printf 'Rust loopback daemon readiness     : OK\n'
printf 'Bun Cloudflare auth mode           : OK\n'
printf 'direct forged Access JWT -> 401    : OK\n'
printf 'public missing credentials rejected: OK (HTTP %s)\n' "$public_unauth_status"
printf 'public wrong secret rejected       : OK (HTTP %s)\n' "$wrong_secret_status"
printf 'Access service token accepted      : OK\n'
printf 'Cloudflare -> Bun -> Rust enqueue  : OK (task_id=1)\n'
printf 'public durable replay              : OK (same task_id)\n'
printf 'public idempotency conflict -> 409 : OK\n'
printf 'registry mapping                   : OK (document.process -> cpu)\n'
printf 'public payload non-disclosure      : OK\n'
printf 'SQLite persistence                 : OK\n'
printf '\nCloudflare Access -> Termux provenance integration: OK\n'

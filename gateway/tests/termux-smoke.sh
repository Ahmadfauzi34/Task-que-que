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
TOKEN="termux-smoke-local-only-$$"
IDEMPOTENCY_KEY="termux-physical-proof-$$"

print_logs() {
  if [ -s "$RUST_LOG" ]; then
    printf '\n--- Rust daemon log ---\n' >&2
    cat "$RUST_LOG" >&2 || true
  fi
  if [ -s "$BUN_LOG" ]; then
    printf '\n--- Bun gateway log ---\n' >&2
    cat "$BUN_LOG" >&2 || true
  fi
}

fail() {
  printf 'termux smoke error: %s\n' "$*" >&2
  print_logs
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
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done

  printf 'service did not become ready: %s\n' "$url" >&2
  cat "$log_file" >&2 || true
  return 1
}

require_command curl
require_command grep
require_command sed
require_command mktemp
require_executable "$RUST_BIN"
require_executable "$BUN_BIN"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; physical reference proof currently targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found at /system/bin/linker64"

RUST_VERSION="$("$RUST_BIN" version 2>/dev/null || true)"
[ -n "$RUST_VERSION" ] || fail "Rust queue binary could not execute"
BUN_VERSION="$("$BUN_BIN" --version 2>/dev/null || true)"
[ -n "$BUN_VERSION" ] || fail "Bun Android runtime could not execute"

# Do not attach to or kill an already-running service. The smoke proof owns both ports.
if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "port 7331 already has a queue daemon; stop it before running the isolated smoke proof"
fi
if curl -fsS --max-time 1 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
  fail "port 3000 already has a gateway; stop it before running the isolated smoke proof"
fi

printf 'Physical Termux gateway proof\n'
printf 'architecture : %s\n' "$ARCH"
printf 'rust binary  : %s\n' "$RUST_VERSION"
printf 'bun runtime  : %s\n' "$BUN_VERSION"

"$RUST_BIN" serve --db "$TMP_DIR/queue.db" >"$RUST_LOG" 2>&1 &
RUST_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" "$RUST_LOG" || fail "Rust queue daemon readiness failed"
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
wait_for_url "http://127.0.0.1:3000/readyz" "$BUN_LOG" || fail "Bun gateway readiness failed"
kill -0 "$BUN_PID" >/dev/null 2>&1 || fail "Bun gateway exited after readiness"

rust_health="$(curl -fsS http://127.0.0.1:7331/healthz)"
printf '%s' "$rust_health" | grep -F '"status":"ok"' >/dev/null || fail "Rust health response was unexpected"

gateway_health="$(curl -fsS http://127.0.0.1:3000/healthz)"
printf '%s' "$gateway_health" | grep -F '"status":"ok"' >/dev/null || fail "gateway health response was unexpected"

ready="$(curl -fsS http://127.0.0.1:3000/readyz)"
printf '%s' "$ready" | grep -F '"queue":"ready"' >/dev/null || fail "gateway did not prove upstream readiness"

unauthorized_status="$(
  curl -sS -o "$TMP_DIR/unauthorized.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Content-Type: application/json' \
    --data-binary '{"type":"document.process","payload":{"document_id":"termux-unauthorized"}}'
)"
[ "$unauthorized_status" = "401" ] || fail "unauthorized create returned HTTP $unauthorized_status instead of 401"

missing_key_status="$(
  curl -sS -o "$TMP_DIR/missing-key.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary '{"type":"document.process","payload":{"document_id":"missing-key"}}'
)"
[ "$missing_key_status" = "400" ] || fail "missing Idempotency-Key returned HTTP $missing_key_status instead of 400"

TASK_BODY='{"type":"document.process","payload":{"document_id":"termux-physical-proof"},"priority":10,"max_retries":3}'
created="$(
  curl -fsS -X POST http://127.0.0.1:3000/v1/tasks \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
printf '%s' "$created" | grep -F '"status":"PENDING"' >/dev/null || fail "authorized task was not accepted as PENDING"
printf '%s' "$created" | grep -F '"replayed":false' >/dev/null || fail "first idempotent enqueue was not marked created"

TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[ -n "$TASK_ID" ] || fail "could not extract task_id from create response"

replayed="$(
  curl -fsS -X POST http://127.0.0.1:3000/v1/tasks \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
printf '%s' "$replayed" | grep -F "\"task_id\":$TASK_ID" >/dev/null || fail "idempotency replay returned a different task id"
printf '%s' "$replayed" | grep -F '"replayed":true' >/dev/null || fail "idempotency replay was not marked replayed"

conflict_status="$(
  curl -sS -o "$TMP_DIR/conflict.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary '{"type":"document.process","payload":{"document_id":"changed"},"priority":10,"max_retries":3}'
)"
[ "$conflict_status" = "409" ] || fail "idempotency conflict returned HTTP $conflict_status instead of 409"

snapshot="$(
  curl -fsS "http://127.0.0.1:3000/v1/tasks/$TASK_ID" \
    -H "Authorization: Bearer $TOKEN"
)"
printf '%s' "$snapshot" | grep -F '"task_name":"document.process"' >/dev/null || fail "task name was not preserved"
printf '%s' "$snapshot" | grep -F '"task_type":"cpu"' >/dev/null || fail "registry did not map document.process to cpu"
printf '%s' "$snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "task snapshot status was unexpected"

if printf '%s' "$snapshot" | grep -F '"payload"' >/dev/null; then
  fail "public task snapshot leaked payload"
fi

if curl -fsS "http://127.0.0.1:3000/v1/tasks/2" \
  -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1; then
  fail "idempotency replay unexpectedly created a second task"
fi

[ -s "$TMP_DIR/queue.db" ] || fail "SQLite queue database was not created"

printf '\nProof state\n'
printf 'Android ARM64 runtime        : OK\n'
printf 'Rust daemon readiness        : OK\n'
printf 'Bun Android execution        : OK\n'
printf 'Bun -> Rust readiness        : OK\n'
printf 'unauthorized create -> 401   : OK\n'
printf 'Idempotency-Key required     : OK\n'
printf 'authorized enqueue           : OK (task_id=%s)\n' "$TASK_ID"
printf 'durable idempotency replay   : OK (same task_id)\n'
printf 'idempotency conflict -> 409  : OK\n'
printf 'registry mapping             : OK (document.process -> cpu)\n'
printf 'public payload non-disclosure: OK\n'
printf 'SQLite persistence path      : OK\n'
printf '\nTermux Bun -> Rust idempotent integration: OK\n'

#!/data/data/com.termux/files/usr/bin/sh
set -eu

TMP_DIR="$(mktemp -d)"
RUST_BIN="${TASK_QUEUE_RUST_BIN:-robust-sinkhorn-queue}"
RUST_PID=""
CURL_PID=""
RUST_LOG="$TMP_DIR/rust.log"
RESTART_LOG="$TMP_DIR/restart.log"
DB_PATH="$TMP_DIR/queue.db"
BODY_FILE="$TMP_DIR/body.txt"
STATUS_FILE="$TMP_DIR/status.txt"
RESPONSE_FILE="$TMP_DIR/response.json"

fail() {
  printf 'termux shutdown smoke error: %s\n' "$*" >&2
  if [ -s "$RUST_LOG" ]; then
    printf '\n--- Rust daemon log ---\n' >&2
    cat "$RUST_LOG" >&2 || true
  fi
  if [ -s "$RESTART_LOG" ]; then
    printf '\n--- Restart daemon log ---\n' >&2
    cat "$RESTART_LOG" >&2 || true
  fi
  exit 1
}

cleanup() {
  if [ -n "$CURL_PID" ]; then
    kill "$CURL_PID" >/dev/null 2>&1 || true
    wait "$CURL_PID" >/dev/null 2>&1 || true
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
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  cat "$log_file" >&2 || true
  return 1
}

require_command curl
require_command grep
require_command mktemp
require_command dd
require_command tr
require_executable "$RUST_BIN"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; physical reference proof targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found"

if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "port 7331 already has a queue daemon; stop it before running the isolated proof"
fi

# 16 KiB of UTF-8 payload sent slowly enough that SIGINT can happen after accept.
dd if=/dev/zero bs=1024 count=16 2>/dev/null | tr '\000' 'x' >"$BODY_FILE"

"$RUST_BIN" serve --db "$DB_PATH" >"$RUST_LOG" 2>&1 &
RUST_PID=$!
wait_for_url http://127.0.0.1:7331/readyz "$RUST_LOG" || fail "daemon did not become ready"

(
  curl -sS --max-time 20 --limit-rate 4096 \
    -o "$RESPONSE_FILE" -w '%{http_code}' \
    -X POST http://127.0.0.1:7331/v1/tasks \
    -H 'X-Task-Name: shutdown.proof' \
    -H 'X-Task-Type: cpu' \
    -H 'X-Task-Priority: 1' \
    -H 'X-Task-Max-Retries: 0' \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$BODY_FILE" >"$STATUS_FILE"
) &
CURL_PID=$!

# Give curl time to connect and begin the deliberately slow body upload.
sleep 1
kill -INT "$RUST_PID" || fail "could not send SIGINT to daemon"
sleep 0.2

kill -0 "$RUST_PID" >/dev/null 2>&1 || fail "daemon exited before its accepted request drained"

# Listener must be gone while the already accepted request is still draining.
if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "daemon still accepted a new connection after shutdown transition"
fi

wait "$CURL_PID" || fail "accepted request failed while daemon was draining"
CURL_PID=""
[ "$(cat "$STATUS_FILE")" = "202" ] || fail "accepted request did not complete with HTTP 202"
grep -F '"status":"PENDING"' "$RESPONSE_FILE" >/dev/null || fail "accepted enqueue response was unexpected"

wait "$RUST_PID" || fail "daemon exited with an error after draining"
RUST_PID=""
grep -F 'shutdown requested' "$RUST_LOG" >/dev/null || fail "shutdown transition was not logged"
grep -F 'draining accepted connections:' "$RUST_LOG" >/dev/null || fail "accepted connection drain was not observed"
grep -F 'shutdown complete' "$RUST_LOG" >/dev/null || fail "shutdown completion was not logged"

# Restart the same SQLite database and prove the drained enqueue survived process exit.
"$RUST_BIN" serve --db "$DB_PATH" >"$RESTART_LOG" 2>&1 &
RUST_PID=$!
wait_for_url http://127.0.0.1:7331/readyz "$RESTART_LOG" || fail "restarted daemon did not become ready"

snapshot="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/1)" || fail "persisted task was not queryable after restart"
printf '%s' "$snapshot" | grep -F '"task_name":"shutdown.proof"' >/dev/null || fail "persisted task name was unexpected"
printf '%s' "$snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "persisted task status was unexpected"

kill -INT "$RUST_PID" || fail "could not stop restarted daemon"
wait "$RUST_PID" || fail "restarted daemon did not stop cleanly"
RUST_PID=""

printf 'Physical Termux graceful shutdown proof\n'
printf 'architecture                    : %s\n' "$ARCH"
printf '\nProof state\n'
printf 'accepted request tracked         : OK\n'
printf 'SIGINT starts shutdown            : OK\n'
printf 'new connection after SIGINT       : REJECTED\n'
printf 'daemon alive during drain         : OK\n'
printf 'accepted enqueue completes -> 202 : OK\n'
printf 'shutdown waits for drain          : OK\n'
printf 'SQLite task survives restart      : OK\n'
printf '\nTermux graceful drain shutdown: OK\n'

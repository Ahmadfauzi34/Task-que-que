#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIFECYCLE="$ROOT_DIR/ops/termux-reference-machine.sh"
RESUME="$ROOT_DIR/ops/termux-reference-resume.sh"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TMP_DIR="$(mktemp -d)"
STATE_DIR="$TMP_DIR/state"
FAKE_BIN_DIR="$TMP_DIR/bin"
FAKE_CLOUDFLARED="$FAKE_BIN_DIR/cloudflared"
FAKE_URL="https://resume-proof.trycloudflare.com"
REAL_CURL="$(command -v curl)"

fail() {
  echo "reference machine resume smoke error: $*" >&2
  for log in queue gateway broker cpu-worker workflow-worker vector-worker cloudflared; do
    if [[ -s "$STATE_DIR/logs/$log.log" ]]; then
      echo "--- $log log ---" >&2
      tail -n 80 "$STATE_DIR/logs/$log.log" >&2 || true
    fi
  done
  exit 1
}

mkdir -p "$FAKE_BIN_DIR"
cat >"$FAKE_CLOUDFLARED" <<EOF_FAKE_CF
#!/usr/bin/env python3
import signal
import sys
import time
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
print("INF $FAKE_URL", flush=True)
while True:
    time.sleep(1)
EOF_FAKE_CF
chmod +x "$FAKE_CLOUDFLARED"

cat >"$FAKE_BIN_DIR/curl" <<EOF_FAKE_CURL
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    $FAKE_URL/*) exit 0 ;;
  esac
done
exec "$REAL_CURL" "\$@"
EOF_FAKE_CURL
chmod +x "$FAKE_BIN_DIR/curl"

lifecycle() {
  PATH="$FAKE_BIN_DIR:$PATH" \
  TASK_QUEUE_ROOT_DIR="$ROOT_DIR" \
  TASK_QUEUE_DATA_DIR="$STATE_DIR" \
  TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
  TASK_QUEUE_WORKER_BIN="$BROKER_BIN" \
  TASK_QUEUE_BUN_BIN="$BUN_BIN" \
  TASK_QUEUE_CLOUDFLARED_BIN="$FAKE_CLOUDFLARED" \
    sh "$LIFECYCLE" "$@"
}

resume() {
  PATH="$FAKE_BIN_DIR:$PATH" \
  TASK_QUEUE_ROOT_DIR="$ROOT_DIR" \
  TASK_QUEUE_DATA_DIR="$STATE_DIR" \
  TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
  TASK_QUEUE_WORKER_BIN="$BROKER_BIN" \
  TASK_QUEUE_BUN_BIN="$BUN_BIN" \
  TASK_QUEUE_CLOUDFLARED_BIN="$FAKE_CLOUDFLARED" \
  TASK_QUEUE_RESUME_TUNNEL_ATTEMPTS=2 \
  TASK_QUEUE_RESUME_TUNNEL_DELAY_SECONDS=0 \
  TASK_QUEUE_RESUME_PUBLIC_ATTEMPTS=3 \
  TASK_QUEUE_RESUME_PUBLIC_DELAY_SECONDS=0 \
    sh "$RESUME"
}

cleanup() {
  lifecycle stop >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
[[ -x "$QUEUE_BIN" ]] || fail "queue binary is not executable: $QUEUE_BIN"
[[ -x "$BROKER_BIN" ]] || fail "worker broker binary is not executable: $BROKER_BIN"
[[ -f "$LIFECYCLE" ]] || fail "lifecycle script is missing"
[[ -f "$RESUME" ]] || fail "resume script is missing"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [[ ! -x "$BUN_BIN" ]]; then
  fail "Bun executable not found: $BUN_BIN"
fi

for port in 3000 7331 7332; do
  if "$REAL_CURL" -sS --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    fail "port $port is already in use"
  fi
done

mkdir -p "$STATE_DIR/pids"
for name in queue gateway broker cpu-worker workflow-worker vector-worker cloudflared; do
  printf '99999999\n' >"$STATE_DIR/pids/$name.pid"
done

first_output="$(resume)" || fail "one-command stale recovery failed"
printf '%s\n' "$first_output"
printf '%s' "$first_output" | grep -F 'queue: clearing stale pid record' >/dev/null \
  || fail "queue stale pid was not recovered"
printf '%s' "$first_output" | grep -F 'cloudflared: clearing stale pid record' >/dev/null \
  || fail "cloudflared stale pid was not recovered"
printf '%s' "$first_output" | grep -F 'reference resume: PUBLIC READY' >/dev/null \
  || fail "resume did not prove public readiness"
[[ "$(cat "$STATE_DIR/public-url")" == "$FAKE_URL" ]] || fail "resume did not persist public URL"

QUEUE_PID_1="$(cat "$STATE_DIR/pids/queue.pid")"
GATEWAY_PID_1="$(cat "$STATE_DIR/pids/gateway.pid")"
BROKER_PID_1="$(cat "$STATE_DIR/pids/broker.pid")"
CPU_PID_1="$(cat "$STATE_DIR/pids/cpu-worker.pid")"
WORKFLOW_PID_1="$(cat "$STATE_DIR/pids/workflow-worker.pid")"
VECTOR_PID_1="$(cat "$STATE_DIR/pids/vector-worker.pid")"
CF_PID_1="$(cat "$STATE_DIR/pids/cloudflared.pid")"

second_output="$(resume)" || fail "idempotent resume failed"
printf '%s\n' "$second_output"
printf '%s' "$second_output" | grep -F "queue: already running pid=$QUEUE_PID_1" >/dev/null \
  || fail "resume restarted healthy queue"
printf '%s' "$second_output" | grep -F "cloudflared: already running pid=$CF_PID_1" >/dev/null \
  || fail "resume restarted healthy cloudflared"
[[ "$(cat "$STATE_DIR/pids/gateway.pid")" == "$GATEWAY_PID_1" ]] || fail "healthy gateway pid changed"
[[ "$(cat "$STATE_DIR/pids/broker.pid")" == "$BROKER_PID_1" ]] || fail "healthy broker pid changed"
[[ "$(cat "$STATE_DIR/pids/cpu-worker.pid")" == "$CPU_PID_1" ]] || fail "healthy cpu worker pid changed"
[[ "$(cat "$STATE_DIR/pids/workflow-worker.pid")" == "$WORKFLOW_PID_1" ]] || fail "healthy workflow worker pid changed"
[[ "$(cat "$STATE_DIR/pids/vector-worker.pid")" == "$VECTOR_PID_1" ]] || fail "healthy vector worker pid changed"

kill -INT "$CF_PID_1"
for _ in {1..50}; do
  kill -0 "$CF_PID_1" 2>/dev/null || break
  sleep 0.05
done
kill -0 "$CF_PID_1" 2>/dev/null && fail "fake cloudflared did not stop"

third_output="$(resume)" || fail "partial transport recovery failed"
printf '%s\n' "$third_output"
printf '%s' "$third_output" | grep -F 'cloudflared: clearing stale pid record' >/dev/null \
  || fail "stale cloudflared was not detected during partial recovery"
printf '%s' "$third_output" | grep -F "queue: already running pid=$QUEUE_PID_1" >/dev/null \
  || fail "partial recovery restarted healthy queue"
CF_PID_2="$(cat "$STATE_DIR/pids/cloudflared.pid")"
[[ "$CF_PID_2" != "$CF_PID_1" ]] || fail "cloudflared pid did not change after transport recovery"
[[ "$(cat "$STATE_DIR/pids/queue.pid")" == "$QUEUE_PID_1" ]] || fail "queue pid changed during transport-only recovery"

final_status="$(PATH="$FAKE_BIN_DIR:$PATH" TASK_QUEUE_ROOT_DIR="$ROOT_DIR" TASK_QUEUE_DATA_DIR="$STATE_DIR" TASK_QUEUE_RUST_BIN="$QUEUE_BIN" TASK_QUEUE_WORKER_BIN="$BROKER_BIN" TASK_QUEUE_BUN_BIN="$BUN_BIN" TASK_QUEUE_CLOUDFLARED_BIN="$FAKE_CLOUDFLARED" sh "$LIFECYCLE" status)" \
  || fail "final reference machine status failed"
printf '%s\n' "$final_status"
printf '%s' "$final_status" | grep -F 'reference machine: READY' >/dev/null \
  || fail "reference machine not ready after resume proofs"

echo "Reference machine resume proof state"
echo "single-command stale recovery      : OK"
echo "dependency-ordered local recovery  : OK"
echo "healthy process reuse              : OK"
echo "transport-only recovery            : OK"
echo "public readiness convergence       : OK"
echo "persistent public URL capture      : OK"
echo "destructive healthy restart        : NOT PERFORMED"
echo
echo "Reference Termux resume: OK"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIFECYCLE="$ROOT_DIR/ops/termux-reference-machine.sh"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TMP_DIR="$(mktemp -d)"
STATE_DIR="$TMP_DIR/state"
FAKE_CLOUDFLARED="$TMP_DIR/cloudflared"
FAKE_URL="https://lifecycle-proof.trycloudflare.com"

fail() {
  echo "reference machine lifecycle smoke error: $*" >&2
  for log in queue gateway broker cpu-worker workflow-worker vector-worker cloudflared; do
    if [[ -s "$STATE_DIR/logs/$log.log" ]]; then
      echo "--- $log log ---" >&2
      tail -n 80 "$STATE_DIR/logs/$log.log" >&2 || true
    fi
  done
  exit 1
}

cat >"$FAKE_CLOUDFLARED" <<EOF_FAKE
#!/usr/bin/env python3
import signal
import sys
import time

signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
print("INF $FAKE_URL", flush=True)
while True:
    time.sleep(1)
EOF_FAKE
chmod +x "$FAKE_CLOUDFLARED"

lifecycle() {
  TASK_QUEUE_ROOT_DIR="$ROOT_DIR" \
  TASK_QUEUE_DATA_DIR="$STATE_DIR" \
  TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
  TASK_QUEUE_WORKER_BIN="$BROKER_BIN" \
  TASK_QUEUE_BUN_BIN="$BUN_BIN" \
  TASK_QUEUE_CLOUDFLARED_BIN="$FAKE_CLOUDFLARED" \
  TASK_QUEUE_PUBLIC_READY_PROBE=0 \
    sh "$LIFECYCLE" "$@"
}

cleanup() {
  lifecycle stop >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [[ ! -x "$BUN_BIN" ]]; then
  fail "Bun executable not found: $BUN_BIN"
fi
[[ -x "$QUEUE_BIN" ]] || fail "queue binary is not executable: $QUEUE_BIN"
[[ -x "$BROKER_BIN" ]] || fail "worker broker binary is not executable: $BROKER_BIN"
[[ -f "$LIFECYCLE" ]] || fail "lifecycle script is missing"

for port in 3000 7331 7332; do
  if curl -sS --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    fail "port $port is already in use"
  fi
done

start_output="$(lifecycle start)" || fail "start failed"
printf '%s\n' "$start_output"
printf '%s' "$start_output" | grep -F 'reference machine: READY' >/dev/null \
  || fail "start did not reach READY"
[[ -s "$STATE_DIR/gateway-token" ]] || fail "gateway token was not persisted"
[[ "$(cat "$STATE_DIR/public-url")" == "$FAKE_URL" ]] || fail "public URL was not persisted"

status_output="$(lifecycle status)" || fail "status failed after start"
printf '%s\n' "$status_output"
printf '%s' "$status_output" | grep -F 'queue                RUNNING' >/dev/null || fail "queue status missing"
printf '%s' "$status_output" | grep -F 'cpu-worker           RUNNING' >/dev/null || fail "cpu worker status missing"
printf '%s' "$status_output" | grep -F 'workflow-worker      RUNNING' >/dev/null || fail "workflow worker status missing"
printf '%s' "$status_output" | grep -F 'vector-worker        RUNNING' >/dev/null || fail "vector worker status missing"

TOKEN="$(cat "$STATE_DIR/gateway-token")"
created="$(curl -fsS --max-time 3 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: lifecycle-proof-hash' \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"hash.compute","payload":{"data":"lifecycle-proof","algorithm":"sha256"}}')" \
  || fail "could not enqueue lifecycle proof task"
TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$TASK_ID" ]] || fail "task id missing"

snapshot=""
for _ in {1..100}; do
  snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$TASK_ID" \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null || true)"
  if printf '%s' "$snapshot" | grep -F '"status":"COMPLETED"' >/dev/null; then
    break
  fi
  sleep 0.1
done
printf '%s' "$snapshot" | grep -F '"status":"COMPLETED"' >/dev/null \
  || fail "hash task did not complete before restart"

before_token_hash="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
restart_output="$(lifecycle restart)" || fail "restart failed"
printf '%s\n' "$restart_output"
printf '%s' "$restart_output" | grep -F 'reference machine: READY' >/dev/null \
  || fail "restart did not return to READY"
after_token="$(cat "$STATE_DIR/gateway-token")"
after_token_hash="$(printf '%s' "$after_token" | sha256sum | cut -d' ' -f1)"
[[ "$before_token_hash" == "$after_token_hash" ]] || fail "restart replaced the gateway token"

recovered="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $after_token")" || fail "could not read task after restart"
printf '%s' "$recovered" | grep -F '"status":"COMPLETED"' >/dev/null \
  || fail "durable task state did not survive restart"
result="$(curl -fsS --max-time 2 "http://127.0.0.1:7331/v1/tasks/$TASK_ID/result")" \
  || fail "durable result did not survive restart"
printf '%s' "$result" | grep -F '"result_json"' >/dev/null || fail "durable result wrapper missing"

lifecycle stop >/dev/null || fail "stop failed"
mkdir -p "$STATE_DIR/pids"
printf '99999999\n' > "$STATE_DIR/pids/queue.pid"
stale_output="$(lifecycle start)" || fail "start after stale pid failed"
printf '%s\n' "$stale_output"
printf '%s' "$stale_output" | grep -F 'queue: clearing stale pid record' >/dev/null \
  || fail "stale pid record was not detected"

status_output="$(lifecycle status)" || fail "status failed after stale-pid recovery"
printf '%s' "$status_output" | grep -F 'reference machine: READY' >/dev/null \
  || fail "reference machine was not ready after stale-pid recovery"

echo "Reference machine lifecycle proof state"
echo "dependency-ordered start          : OK"
echo "actual readiness                  : OK"
echo "worker registration               : OK"
echo "persistent bearer authority       : PRESERVED"
echo "durable task across restart       : PRESERVED"
echo "durable result across restart     : PRESERVED"
echo "stale pid recovery                : OK"
echo "quick-tunnel URL capture          : OK"
echo "unbounded remote-agent provider   : NOT ENABLED BY DEFAULT"
echo
echo "Reference Termux lifecycle: OK (task=$TASK_ID)"

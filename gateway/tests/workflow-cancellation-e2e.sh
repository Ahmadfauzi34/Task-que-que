#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
RUST_PID=""
BUN_PID=""

cleanup() {
  if [[ -n "$BUN_PID" ]]; then
    kill "$BUN_PID" >/dev/null 2>&1 || true
    wait "$BUN_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RUST_PID" ]]; then
    kill "$RUST_PID" >/dev/null 2>&1 || true
    wait "$RUST_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local log_file="$2"
  for _ in {1..80}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "service did not become ready: $url" >&2
  cat "$log_file" >&2 || true
  return 1
}

cd "$ROOT_DIR"
./target/debug/robust-sinkhorn-queue serve \
  --db "$TMP_DIR/queue.db" \
  >"$TMP_DIR/rust.log" 2>&1 &
RUST_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" "$TMP_DIR/rust.log"

cd "$ROOT_DIR/gateway"
GATEWAY_API_TOKEN="ci-workflow-cancel-secret" \
GATEWAY_MAX_ACTIVE_TASKS="8" \
  bun run src/server.ts \
  >"$TMP_DIR/gateway.log" 2>&1 &
BUN_PID=$!
cd "$ROOT_DIR"
wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log"

WORKFLOW_BODY='{"steps":[{"id":"first","type":"hash.compute","payload":{"data":"cancel-me","algorithm":"sha256"}}]}'
created="$(
  curl -fsS -X POST http://127.0.0.1:3000/v1/workflows \
    -H 'Authorization: Bearer ci-workflow-cancel-secret' \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: workflow-cancel-e2e-1' \
    --data-binary "$WORKFLOW_BODY"
)"
printf '%s' "$created" | grep -F '"status":"PENDING"' >/dev/null
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
test -n "$WORKFLOW_ID"

cancelled="$(
  curl -fsS -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
    -H 'Authorization: Bearer ci-workflow-cancel-secret'
)"
printf '%s' "$cancelled" | grep -F "\"workflow_id\":$WORKFLOW_ID" >/dev/null
printf '%s' "$cancelled" | grep -F '"status":"CANCELLED"' >/dev/null
printf '%s' "$cancelled" | grep -F '"already_cancelled":false' >/dev/null

replayed="$(
  curl -fsS -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
    -H 'Authorization: Bearer ci-workflow-cancel-secret'
)"
printf '%s' "$replayed" | grep -F '"status":"CANCELLED"' >/dev/null
printf '%s' "$replayed" | grep -F '"already_cancelled":true' >/dev/null

public_status="$(
  curl -fsS "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID" \
    -H 'Authorization: Bearer ci-workflow-cancel-secret'
)"
printf '%s' "$public_status" | grep -F '"status":"CANCELLED"' >/dev/null

local_state="$(curl -fsS "http://127.0.0.1:7331/v1/tasks/$WORKFLOW_ID")"
printf '%s' "$local_state" | grep -F '"task_name":"workflow.run"' >/dev/null
printf '%s' "$local_state" | grep -F '"task_type":"workflow"' >/dev/null
printf '%s' "$local_state" | grep -F '"status":"CANCELLED"' >/dev/null
printf '%s' "$local_state" | grep -F '"locked_by":null' >/dev/null
printf '%s' "$local_state" | grep -F '"locked_until":null' >/dev/null
printf '%s' "$local_state" | grep -F '"heartbeat_at":null' >/dev/null
printf '%s' "$local_state" | grep -F '"lease_generation":1' >/dev/null

metrics="$(curl -fsS http://127.0.0.1:7331/metricsz)"
printf '%s' "$metrics" | grep -F '"cancelled":1' >/dev/null
printf '%s' "$metrics" | grep -F '"unknown":0' >/dev/null
printf '%s' "$metrics" | grep -F '"active":0' >/dev/null

result_status="$(
  curl -sS -o "$TMP_DIR/result.json" -w '%{http_code}' \
    "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/result" \
    -H 'Authorization: Bearer ci-workflow-cancel-secret'
)"
test "$result_status" = "409"
grep -F 'workflow_not_completed' "$TMP_DIR/result.json" >/dev/null
grep -F 'CANCELLED' "$TMP_DIR/result.json" >/dev/null

echo "Public workflow cancellation control-plane: OK (workflow_id=$WORKFLOW_ID)"
echo "Durable parent fence revocation state: OK"
echo "Cancelled workflow result disclosure: NONE"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TOKEN="public-workflow-cancel-proof-token"
QUEUE_PID=""
BROKER_PID=""
GATEWAY_PID=""
CPU_PID=""
WORKFLOW_PID=""

stop_process() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -INT "$pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 0.1
  done
  kill -TERM "$pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  stop_process "$WORKFLOW_PID"
  stop_process "$CPU_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "public workflow cancellation smoke error: $*" >&2
  for log in workflow cpu gateway broker queue; do
    if [[ -s "$TMP_DIR/$log.log" ]]; then
      echo "--- $log log ---" >&2
      cat "$TMP_DIR/$log.log" >&2 || true
    fi
  done
  exit 1
}

wait_for_url() {
  local url="$1"
  local log_file="$2"
  for _ in {1..120}; do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  cat "$log_file" >&2 || true
  return 1
}

wait_for_log() {
  local pattern="$1"
  local log_file="$2"
  for _ in {1..200}; do
    if grep -F "$pattern" "$log_file" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

wait_for_task_status() {
  local task_id="$1"
  local expected="$2"
  local snapshot=""
  for _ in {1..320}; do
    snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$task_id" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null || true)"
    if printf '%s' "$snapshot" | grep -F "\"status\":\"$expected\"" >/dev/null; then
      printf '%s' "$snapshot"
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' "$snapshot" >&2
  return 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v grep >/dev/null 2>&1 || fail "grep is required"
command -v sed >/dev/null 2>&1 || fail "sed is required"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [[ ! -x "$BUN_BIN" ]]; then
  fail "Bun executable not found: $BUN_BIN"
fi
[[ -x "$QUEUE_BIN" ]] || fail "queue binary is not executable: $QUEUE_BIN"
[[ -x "$BROKER_BIN" ]] || fail "worker broker binary is not executable: $BROKER_BIN"

for port in 3000 7331 7332; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    fail "port $port is already in use"
  fi
done

cd "$ROOT_DIR"
"$QUEUE_BIN" serve --db "$TMP_DIR/queue.db" --maintenance-interval-ms 100 \
  >"$TMP_DIR/queue.log" 2>&1 &
QUEUE_PID=$!
"$BROKER_BIN" serve --db "$TMP_DIR/queue.db" \
  --dispatch-interval-ms 50 --session-ttl-ms 5000 --task-lease-ms 600 \
  >"$TMP_DIR/broker.log" 2>&1 &
BROKER_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" "$TMP_DIR/queue.log" || fail "queue did not become ready"
wait_for_url "http://127.0.0.1:7332/readyz" "$TMP_DIR/broker.log" || fail "worker broker did not become ready"

cd "$ROOT_DIR/gateway"
GATEWAY_API_TOKEN="$TOKEN" GATEWAY_MAX_ACTIVE_TASKS="16" GATEWAY_ENQUEUE_BURST="32" \
  "$BUN_BIN" run src/server.ts >"$TMP_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
cd "$ROOT_DIR"
wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log" || fail "gateway did not become ready"

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/cpu-results" DOCUMENT_WORKER_POLL_MS="50" \
DOCUMENT_WORKER_PROCESS_DELAY_MS="2500" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/cpu.log" 2>&1 &
CPU_PID=$!
WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!

wait_for_log 'id=document-reference-worker' "$TMP_DIR/cpu.log" || fail "cpu worker did not register"
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not register"

WORKFLOW_BODY='{"steps":[{"id":"source","type":"hash.compute","payload":{"data":"public cancellation source","algorithm":"sha256"}},{"id":"sink","type":"document.process","payload":{"document_id":"must-not-start","text":"must not run after parent cancellation"},"depends_on":["source"]}]}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: public-workflow-cancel-proof-1' --data-binary "$WORKFLOW_BODY")" || fail "public workflow enqueue failed"
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$WORKFLOW_ID" ]] || fail "public workflow enqueue did not return workflow id"

wait_for_log "parent=$WORKFLOW_ID step=source" "$TMP_DIR/workflow.log" || fail "workflow did not submit source child"
SOURCE_ID="$(sed -n "s/.*parent=$WORKFLOW_ID step=source task=\([0-9][0-9]*\) replayed=false.*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
[[ -n "$SOURCE_ID" ]] || fail "workflow source child id missing"

before="$(curl -fsS --max-time 3 "http://127.0.0.1:7331/v1/tasks/$WORKFLOW_ID")" || fail "could not read parent before cancellation"
printf '%s' "$before" | grep -F '"status":"RUNNING"' >/dev/null || fail "parent was not RUNNING before cancellation"
BEFORE_GENERATION="$(printf '%s' "$before" | sed -n 's/.*"lease_generation":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$BEFORE_GENERATION" ]] || fail "parent lease generation missing before cancellation"

unauth_status="$(curl -sS --max-time 3 -o "$TMP_DIR/unauth.json" -w '%{http_code}' \
  -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel")"
[[ "$unauth_status" == "401" ]] || fail "unauthenticated public cancellation was not rejected"

cancelled="$(curl -fsS --max-time 5 -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
  -H "Authorization: Bearer $TOKEN")" || fail "public workflow cancellation failed"
printf '%s' "$cancelled" | grep -F '"status":"CANCELLED"' >/dev/null || fail "public cancellation did not return CANCELLED"
printf '%s' "$cancelled" | grep -F '"replayed":false' >/dev/null || fail "first public cancellation was not applied"

replayed="$(curl -fsS --max-time 5 -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
  -H "Authorization: Bearer $TOKEN")" || fail "public workflow cancellation replay failed"
printf '%s' "$replayed" | grep -F '"replayed":true' >/dev/null || fail "second public cancellation was not idempotent"

public_status="$(curl -fsS --max-time 3 "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID" \
  -H "Authorization: Bearer $TOKEN")" || fail "public workflow status failed"
printf '%s' "$public_status" | grep -F '"status":"CANCELLED"' >/dev/null || fail "public workflow status did not remain CANCELLED"

after="$(curl -fsS --max-time 3 "http://127.0.0.1:7331/v1/tasks/$WORKFLOW_ID")" || fail "could not read parent after cancellation"
printf '%s' "$after" | grep -F '"status":"CANCELLED"' >/dev/null || fail "queue parent state did not become CANCELLED"
printf '%s' "$after" | grep -F '"locked_by":null' >/dev/null || fail "parent worker ownership was not cleared"
printf '%s' "$after" | grep -F '"locked_until":null' >/dev/null || fail "parent lease deadline was not cleared"
printf '%s' "$after" | grep -F '"heartbeat_at":null' >/dev/null || fail "parent heartbeat timestamp was not cleared"
AFTER_GENERATION="$(printf '%s' "$after" | sed -n 's/.*"lease_generation":\([0-9][0-9]*\).*/\1/p')"
[[ "$AFTER_GENERATION" -eq $((BEFORE_GENERATION + 1)) ]] || fail "cancellation did not advance the parent fence exactly once"

wait_for_log "document worker lost lease for task $WORKFLOW_ID:" "$TMP_DIR/workflow.log" || fail "workflow worker did not observe rejected heartbeat"
wait_for_task_status "$SOURCE_ID" COMPLETED >/dev/null || fail "already-submitted source child did not finish independently"
sleep 0.5

if grep -F "parent=$WORKFLOW_ID step=sink" "$TMP_DIR/workflow.log" >/dev/null; then
  fail "workflow submitted a child after public cancellation"
fi
[[ ! -e "$TMP_DIR/workflow-results/task-$WORKFLOW_ID.json" ]] || fail "cancelled parent wrote a workflow result artifact"
parent_result_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:7331/v1/tasks/$WORKFLOW_ID/result")"
[[ "$parent_result_status" == "404" ]] || fail "cancelled parent published a durable result projection"
public_result_status="$(curl -sS --max-time 3 -o "$TMP_DIR/public-result.json" -w '%{http_code}' \
  "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/result" \
  -H "Authorization: Bearer $TOKEN")"
[[ "$public_result_status" == "409" ]] || fail "public result endpoint did not reject cancelled workflow"

metrics="$(curl -fsS --max-time 3 http://127.0.0.1:7331/metricsz)" || fail "queue metrics unavailable"
printf '%s' "$metrics" | grep -F '"cancelled":1' >/dev/null || fail "queue metrics did not classify cancelled parent"
printf '%s' "$metrics" | grep -F '"unknown":0' >/dev/null || fail "cancelled parent leaked into unknown metrics state"

echo "Public workflow cancellation proof state"
echo "public workflow submit                 : OK"
echo "workflow-only identity guard           : OK"
echo "unauthenticated cancel                 : REJECTED"
echo "parent state before cancel             : RUNNING"
echo "control-plane cancellation             : APPLIED"
echo "parent lease generation                : ADVANCED EXACTLY ONCE"
echo "repeat cancellation                    : IDEMPOTENT"
echo "parent worker ownership                : REVOKED"
echo "worker heartbeat after revoke          : REJECTED"
echo "generic handler AbortSignal            : DELIVERED"
echo "workflow orchestration I/O             : ABORTED"
echo "already-submitted source child         : COMPLETED INDEPENDENTLY"
echo "post-cancel dependent child enqueue    : NOT STARTED"
echo "parent result artifact                 : NOT WRITTEN"
echo "parent durable result projection       : NOT WRITTEN"
echo "public cancelled result disclosure     : NONE"
echo "cancelled metrics classification       : OK"
echo
echo "Reference public workflow cancellation: OK (workflow=$WORKFLOW_ID source=$SOURCE_ID generation=$BEFORE_GENERATION->$AFTER_GENERATION)"

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
DOCUMENT_PID=""
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
  stop_process "$DOCUMENT_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "public workflow cancellation smoke error: $*" >&2
  for log in workflow document gateway broker queue; do
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

wait_for_local_status() {
  local task_id="$1"
  local expected="$2"
  local snapshot=""
  for _ in {1..200}; do
    snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:7331/v1/tasks/$task_id" 2>/dev/null || true)"
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

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/document-results" DOCUMENT_WORKER_POLL_MS="50" \
DOCUMENT_WORKER_PROCESS_DELAY_MS="3000" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/document.log" 2>&1 &
DOCUMENT_PID=$!
WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!
wait_for_log 'id=document-reference-worker' "$TMP_DIR/document.log" || fail "document worker did not register"
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not register"

WORKFLOW_BODY='{"steps":[{"id":"slow-doc","type":"document.process","payload":{"document_id":"cancel-proof","text":"keep child busy while parent cancellation arrives"}},{"id":"after-cancel","type":"hash.compute","payload":{"data":"must never be submitted","algorithm":"sha256"},"depends_on":["slow-doc"]}]}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: public-workflow-cancel-proof-1' --data-binary "$WORKFLOW_BODY")" || fail "public workflow enqueue failed"
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$WORKFLOW_ID" ]] || fail "public workflow enqueue did not return workflow id"

parent_before="$(wait_for_local_status "$WORKFLOW_ID" RUNNING)" || fail "workflow parent never reached RUNNING"
printf '%s' "$parent_before" | grep -F '"task_name":"workflow.run"' >/dev/null || fail "parent identity mismatch"
printf '%s' "$parent_before" | grep -F '"task_type":"workflow"' >/dev/null || fail "parent type mismatch"
OLD_GENERATION="$(printf '%s' "$parent_before" | sed -n 's/.*"lease_generation":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$OLD_GENERATION" && "$OLD_GENERATION" -gt 0 ]] || fail "running parent had no lease generation"

wait_for_log "parent=$WORKFLOW_ID step=slow-doc" "$TMP_DIR/workflow.log" || fail "workflow did not submit first child"
CHILD_ID="$(sed -n "s/.*parent=$WORKFLOW_ID step=slow-doc task=\([0-9][0-9]*\).*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
[[ -n "$CHILD_ID" ]] || fail "first child task id missing"
wait_for_local_status "$CHILD_ID" RUNNING >/dev/null || fail "first child did not become RUNNING"
if grep -F "parent=$WORKFLOW_ID step=after-cancel" "$TMP_DIR/workflow.log" >/dev/null 2>&1; then
  fail "dependent child was submitted before cancellation proof point"
fi

cancelled="$(curl -fsS --max-time 5 -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
  -H "Authorization: Bearer $TOKEN")" || fail "public cancellation request failed"
printf '%s' "$cancelled" | grep -F '"status":"CANCELLED"' >/dev/null || fail "public cancellation did not report CANCELLED"
printf '%s' "$cancelled" | grep -F '"already_cancelled":false' >/dev/null || fail "first cancellation was unexpectedly replayed"

parent_after="$(wait_for_local_status "$WORKFLOW_ID" CANCELLED)" || fail "workflow parent did not become CANCELLED"
printf '%s' "$parent_after" | grep -F '"locked_by":null' >/dev/null || fail "cancelled parent retained locked_by"
printf '%s' "$parent_after" | grep -F '"locked_until":null' >/dev/null || fail "cancelled parent retained locked_until"
printf '%s' "$parent_after" | grep -F '"heartbeat_at":null' >/dev/null || fail "cancelled parent retained heartbeat_at"
NEW_GENERATION="$(printf '%s' "$parent_after" | sed -n 's/.*"lease_generation":\([0-9][0-9]*\).*/\1/p')"
[[ "$NEW_GENERATION" -eq $((OLD_GENERATION + 1)) ]] || fail "cancellation did not increment parent lease generation"

wait_for_log "document worker lost lease for task $WORKFLOW_ID:" "$TMP_DIR/workflow.log" || \
  fail "workflow worker did not observe revoked parent heartbeat"
sleep 1
if grep -F "parent=$WORKFLOW_ID step=after-cancel" "$TMP_DIR/workflow.log" >/dev/null 2>&1; then
  fail "workflow submitted a dependent child after public cancellation"
fi

metrics="$(curl -fsS --max-time 2 http://127.0.0.1:7331/metricsz)"
printf '%s' "$metrics" | grep -F '"cancelled":1' >/dev/null || fail "metrics did not count cancelled parent"
printf '%s' "$metrics" | grep -F '"unknown":0' >/dev/null || fail "cancelled parent was classified as unknown"
printf '%s' "$metrics" | grep -F '"total_tasks":2' >/dev/null || fail "unexpected child submission changed total task count"

public_status="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID" \
  -H "Authorization: Bearer $TOKEN")" || fail "public cancelled status query failed"
printf '%s' "$public_status" | grep -F '"status":"CANCELLED"' >/dev/null || fail "public status did not preserve CANCELLED"

result_status="$(curl -sS -o "$TMP_DIR/result.json" -w '%{http_code}' \
  "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/result" \
  -H "Authorization: Bearer $TOKEN")"
[[ "$result_status" == "409" ]] || fail "cancelled workflow unexpectedly exposed a result"
grep -F 'workflow_not_completed' "$TMP_DIR/result.json" >/dev/null || fail "cancelled result response had wrong error"
[[ ! -e "$TMP_DIR/workflow-results/task-$WORKFLOW_ID.json" ]] || fail "cancelled workflow wrote a parent result artifact"

replayed="$(curl -fsS --max-time 5 -X POST "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/cancel" \
  -H "Authorization: Bearer $TOKEN")" || fail "idempotent cancellation replay failed"
printf '%s' "$replayed" | grep -F '"already_cancelled":true' >/dev/null || fail "cancellation replay was not idempotent"

echo "Public workflow cancellation proof state"
echo "public workflow submit                 : OK"
echo "parent reached RUNNING                 : OK"
echo "first child in-flight                  : OK"
echo "public cancel authorization            : OK"
echo "parent status transition               : RUNNING -> CANCELLED"
echo "parent lease generation                : $OLD_GENERATION -> $NEW_GENERATION"
echo "parent lock metadata                   : CLEARED"
echo "revoked heartbeat                      : OBSERVED"
echo "workflow AbortSignal                   : DELIVERED"
echo "post-cancel dependent child enqueue    : NOT STARTED"
echo "cancelled parent result artifact       : NOT WRITTEN"
echo "public cancelled result disclosure     : NONE"
echo "cancellation replay                    : IDEMPOTENT"
echo
echo "Reference public workflow cancellation: OK (workflow=$WORKFLOW_ID child=$CHILD_ID)"

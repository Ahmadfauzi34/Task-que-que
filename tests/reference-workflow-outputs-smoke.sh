#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TOKEN="workflow-output-proof-token"
REMOTE_SECRET="workflow-output-remote-secret"
QUEUE_PID=""
BROKER_PID=""
GATEWAY_PID=""
MOCK_PID=""
REMOTE_PID=""
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
  stop_process "$REMOTE_PID"
  stop_process "$MOCK_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "workflow outputs smoke error: $*" >&2
  for log in workflow remote mock gateway broker queue; do
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
  for _ in {1..160}; do
    if grep -F "$pattern" "$log_file" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

wait_for_workflow_status() {
  local workflow_id="$1"
  local expected="$2"
  local snapshot=""
  for _ in {1..300}; do
    snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/workflows/$workflow_id" \
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

for port in 3000 7331 7332 7440; do
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

MOCK_AGENT_TOKEN="$REMOTE_SECRET" MOCK_AGENT_LOG="$TMP_DIR/mock-calls.log" MOCK_AGENT_DELAY_MS="900" \
  "$BUN_BIN" run workers/remote-agent-bun/tests/mock-agent.ts >"$TMP_DIR/mock.log" 2>&1 &
MOCK_PID=$!
wait_for_url "http://127.0.0.1:7440/healthz" "$TMP_DIR/mock.log" || fail "mock remote agent did not become ready"

REMOTE_AGENT_ENDPOINT="http://127.0.0.1:7440/invoke" REMOTE_AGENT_PROVIDER_ID="workflow-output-mock" \
REMOTE_AGENT_BEARER_TOKEN="$REMOTE_SECRET" REMOTE_AGENT_OUTPUT_DIR="$TMP_DIR/remote-results" \
REMOTE_AGENT_WORKER_POLL_MS="50" REMOTE_AGENT_REQUEST_TIMEOUT_MS="5000" \
  "$BUN_BIN" run workers/remote-agent-bun/src/worker.ts >"$TMP_DIR/remote.log" 2>&1 &
REMOTE_PID=$!
WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_RESULT_ORIGIN="http://127.0.0.1:7331" \
WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!

wait_for_log 'id=remote-agent-reference-worker' "$TMP_DIR/remote.log" || fail "remote agent worker did not register"
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not register"

WORKFLOW_BODY='{"steps":[{"id":"agent","type":"agent.invoke","payload":{"request_id":"declared-output-proof","input":{"prompt":"bounded public output"}}}],"outputs":{"accepted":{"$from":"agent","path":"result.accepted"},"agent":{"$from":"agent","path":"meta.agent"}}}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: declared-workflow-output-1' --data-binary "$WORKFLOW_BODY")" || fail "workflow submit failed"
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$WORKFLOW_ID" ]] || fail "workflow submit did not return workflow id"
wait_for_workflow_status "$WORKFLOW_ID" COMPLETED >/dev/null || fail "workflow did not complete"

public_result="$(curl -fsS --max-time 5 "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/result" \
  -H "Authorization: Bearer $TOKEN")" || fail "public workflow result failed"
printf '%s' "$public_result" | grep -F '"outputs":{"accepted":true,"agent":"bounded-mock"}' >/dev/null || \
  fail "declared public outputs mismatch"
if printf '%s' "$public_result" | grep -E 'provider_id|request_id|input_kind|result_json|result_bytes|lease_generation|locked_by' >/dev/null; then
  fail "undeclared child result or worker internals leaked publicly"
fi

AGENT_ID="$(printf '%s' "$public_result" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$AGENT_ID" ]] || fail "topology did not expose child task id"
child_projection="$(curl -fsS --max-time 2 "http://127.0.0.1:7331/v1/tasks/$AGENT_ID/result")" || \
  fail "child projection missing on loopback"
printf '%s' "$child_projection" | grep -F '"provider_id":"workflow-output-mock"' >/dev/null || \
  fail "loopback child projection was not preserved"

INVALID_BODY='{"steps":[{"id":"agent","type":"agent.invoke","payload":{"input":{"prompt":"must not run"}}}],"outputs":{"answer":{"$from":"missing","path":"result.accepted"}}}'
invalid_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: declared-workflow-output-invalid-1' --data-binary "$INVALID_BODY")" || fail "invalid workflow submit failed"
INVALID_ID="$(printf '%s' "$invalid_created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_ID" ]] || fail "invalid workflow did not return workflow id"
wait_for_workflow_status "$INVALID_ID" FAILED >/dev/null || fail "invalid declared output did not fail closed"
if grep -F "parent=$INVALID_ID step=" "$TMP_DIR/workflow.log" >/dev/null; then
  fail "invalid declared output submitted a child before validation"
fi

echo "Declared workflow output proof state"
echo "public workflow submit/status/result : OK"
echo "explicit output declassification     : OK"
echo "declared agent result.accepted       : EXPORTED"
echo "declared agent meta.agent            : EXPORTED"
echo "undeclared child projection fields   : HIDDEN"
echo "child projection storage             : LOOPBACK ONLY"
echo "unknown output source                : FAILED CLOSED BEFORE CHILD"
echo "eval/template output primitive       : NONE"
echo
echo "Reference declared workflow outputs: OK (workflow=$WORKFLOW_ID agent=$AGENT_ID)"

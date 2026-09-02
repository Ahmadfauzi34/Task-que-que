#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TOKEN="workflow-dataflow-proof-token"
REMOTE_TOKEN="workflow-dataflow-remote-secret"
EXPECTED_DIGEST="4356851d86e96e2579a72f5d519cb32ef1c0f5b5fbbc3bb2e92e9bd3cb376f47"
QUEUE_PID=""
BROKER_PID=""
GATEWAY_PID=""
MOCK_PID=""
CPU_PID=""
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
  stop_process "$CPU_PID"
  stop_process "$MOCK_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "workflow dataflow smoke error: $*" >&2
  for log in workflow remote cpu mock gateway broker queue; do
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

for port in 3000 7331 7332 7441; do
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
GATEWAY_API_TOKEN="$TOKEN" GATEWAY_MAX_ACTIVE_TASKS="32" GATEWAY_ENQUEUE_BURST="64" \
  "$BUN_BIN" run src/server.ts >"$TMP_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
cd "$ROOT_DIR"
wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log" || fail "gateway did not become ready"

MOCK_DATAFLOW_AGENT_TOKEN="$REMOTE_TOKEN" \
MOCK_DATAFLOW_AGENT_LOG="$TMP_DIR/mock-calls.log" \
MOCK_DATAFLOW_EXPECTED_DIGEST="$EXPECTED_DIGEST" \
  "$BUN_BIN" run workers/workflow-bun/tests/mock-dataflow-agent.ts >"$TMP_DIR/mock.log" 2>&1 &
MOCK_PID=$!
wait_for_url "http://127.0.0.1:7441/healthz" "$TMP_DIR/mock.log" || fail "mock dataflow agent did not become ready"

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/cpu-results" DOCUMENT_WORKER_POLL_MS="50" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/cpu.log" 2>&1 &
CPU_PID=$!
REMOTE_AGENT_OUTPUT_DIR="$TMP_DIR/remote-results" REMOTE_AGENT_WORKER_POLL_MS="50" \
REMOTE_AGENT_ENDPOINT="http://127.0.0.1:7441/invoke" REMOTE_AGENT_PROVIDER_ID="workflow-dataflow-mock" \
REMOTE_AGENT_BEARER_TOKEN="$REMOTE_TOKEN" \
  "$BUN_BIN" run workers/remote-agent-bun/src/worker.ts >"$TMP_DIR/remote.log" 2>&1 &
REMOTE_PID=$!
WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_RESULT_ORIGIN="http://127.0.0.1:7331" \
WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!

wait_for_log 'id=document-reference-worker' "$TMP_DIR/cpu.log" || fail "cpu worker did not register"
wait_for_log 'id=remote-agent-reference-worker' "$TMP_DIR/remote.log" || fail "remote agent worker did not register"
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not register"

WORKFLOW_BODY='{"steps":[{"id":"source","type":"hash.compute","payload":{"data":"bounded workflow dataflow","algorithm":"sha256"}},{"id":"agent","type":"agent.invoke","payload":{"request_id":"bounded-dataflow","input":{"digest":{"$from":"source","path":"digest"},"bytes":{"$from":"source","path":"bytes"}}},"depends_on":["source"]}]}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: workflow-dataflow-parent-1' --data-binary "$WORKFLOW_BODY")" || fail "public workflow enqueue failed"
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$WORKFLOW_ID" ]] || fail "public workflow enqueue did not return workflow id"

wait_for_log "parent=$WORKFLOW_ID step=source" "$TMP_DIR/workflow.log" || fail "source step was not submitted"
wait_for_log "parent=$WORKFLOW_ID step=agent" "$TMP_DIR/workflow.log" || fail "agent step was not submitted"
wait_for_workflow_status "$WORKFLOW_ID" COMPLETED >/dev/null || fail "public workflow status did not reach COMPLETED"

[[ -f "$TMP_DIR/mock-calls.log" ]] || fail "mock agent was never called"
[[ "$(wc -l < "$TMP_DIR/mock-calls.log" | tr -d ' ')" = "1" ]] || fail "dataflow agent did not execute exactly once"
grep -F '"digest_match":true' "$TMP_DIR/mock-calls.log" >/dev/null || fail "hash digest was not resolved into agent input"
grep -F '"bytes_match":true' "$TMP_DIR/mock-calls.log" >/dev/null || fail "hash byte count was not resolved into agent input"

SOURCE_ID="$(sed -n "s/.*parent=$WORKFLOW_ID step=source task=\([0-9][0-9]*\).*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
AGENT_ID="$(sed -n "s/.*parent=$WORKFLOW_ID step=agent task=\([0-9][0-9]*\).*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
[[ -n "$SOURCE_ID" ]] || fail "source task id missing"
[[ -n "$AGENT_ID" ]] || fail "agent task id missing"

source_projection="$(curl -fsS --max-time 2 "http://127.0.0.1:7331/v1/tasks/$SOURCE_ID/result")" || fail "source projection was not readable from loopback queue API"
printf '%s' "$source_projection" | grep -F "$EXPECTED_DIGEST" >/dev/null || fail "durable source projection digest mismatch"

workflow_result="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/workflows/$WORKFLOW_ID/result" \
  -H "Authorization: Bearer $TOKEN")" || fail "public workflow result was not readable"
printf '%s' "$workflow_result" | grep -F "\"workflow_id\":$WORKFLOW_ID" >/dev/null || fail "public workflow result id mismatch"
printf '%s' "$workflow_result" | grep -F "\"task_id\":$SOURCE_ID" >/dev/null || fail "public workflow result omitted source topology"
printf '%s' "$workflow_result" | grep -F "\"task_id\":$AGENT_ID" >/dev/null || fail "public workflow result omitted agent topology"
if printf '%s' "$workflow_result" | grep -E 'result_json|result_bytes|digest|payload|lease_generation|locked_by' >/dev/null; then
  fail "public workflow result leaked child result data or worker internals"
fi

PUBLIC_RESULT_CODE="$(curl -sS -o "$TMP_DIR/generic-result.json" -w '%{http_code}' --max-time 2 \
  "http://127.0.0.1:3000/v1/tasks/$WORKFLOW_ID/result" -H "Authorization: Bearer $TOKEN")"
[[ "$PUBLIC_RESULT_CODE" = "404" ]] || fail "generic public task result route unexpectedly exists"

INVALID_BODY='{"steps":[{"id":"left","type":"hash.compute","payload":{"data":"left","algorithm":"sha256"}},{"id":"right","type":"hash.compute","payload":{"data":"right","algorithm":"sha256"}},{"id":"consumer","type":"agent.invoke","payload":{"input":{"digest":{"$from":"right","path":"digest"}}},"depends_on":["left"]}]}'
invalid_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: workflow-dataflow-authority-1' --data-binary "$INVALID_BODY")" || fail "invalid authority workflow enqueue failed"
INVALID_ID="$(printf '%s' "$invalid_created" | sed -n 's/.*"workflow_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_ID" ]] || fail "invalid authority workflow id missing"
wait_for_workflow_status "$INVALID_ID" FAILED >/dev/null || fail "non-ancestor result reference did not fail closed"
if grep -F "parent=$INVALID_ID step=" "$TMP_DIR/workflow.log" >/dev/null; then
  fail "non-ancestor result reference submitted a child before validation"
fi

PUBLIC_SOURCE="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$SOURCE_ID" -H "Authorization: Bearer $TOKEN")" || fail "public source snapshot missing"
if printf '%s' "$PUBLIC_SOURCE" | grep -E 'result_json|digest|payload|lease_generation|locked_by' >/dev/null; then
  fail "public gateway leaked child result projection or worker internals"
fi

echo "Workflow dataflow proof state"
echo "public workflow submit/status/result  : OK"
echo "public workflow topology result       : EXPORTED"
echo "durable child result projection       : READ ON LOOPBACK ONLY"
echo "exact \$from source step               : OK"
echo "bounded exact result path             : OK"
echo "hash digest -> remote agent input     : OK"
echo "hash byte count -> remote agent input : OK"
echo "dependency graph = data authority     : OK"
echo "non-ancestor result reference         : FAILED CLOSED BEFORE CHILD"
echo "public child result disclosure        : NONE"
echo "eval/template/filesystem primitive    : NONE"
echo
echo "Reference workflow dataflow integration: OK (workflow=$WORKFLOW_ID source=$SOURCE_ID)"

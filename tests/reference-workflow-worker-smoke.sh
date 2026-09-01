#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
TOKEN="workflow-proof-token"
REMOTE_TOKEN="workflow-remote-secret"
QUEUE_PID=""
BROKER_PID=""
GATEWAY_PID=""
MOCK_PID=""
CPU_PID=""
VECTOR_PID=""
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
  stop_process "$VECTOR_PID"
  stop_process "$CPU_PID"
  stop_process "$MOCK_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "workflow worker smoke error: $*" >&2
  for log in workflow remote vector cpu mock gateway broker queue; do
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

wait_for_task_status() {
  local task_id="$1"
  local expected="$2"
  local snapshot=""
  for _ in {1..300}; do
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
GATEWAY_API_TOKEN="$TOKEN" GATEWAY_MAX_ACTIVE_TASKS="32" GATEWAY_ENQUEUE_BURST="64" \
  "$BUN_BIN" run src/server.ts >"$TMP_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
cd "$ROOT_DIR"
wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log" || fail "gateway did not become ready"

MOCK_AGENT_TOKEN="$REMOTE_TOKEN" MOCK_AGENT_LOG="$TMP_DIR/mock-calls.log" MOCK_AGENT_DELAY_MS="150" \
  "$BUN_BIN" run workers/remote-agent-bun/tests/mock-agent.ts >"$TMP_DIR/mock.log" 2>&1 &
MOCK_PID=$!
wait_for_url "http://127.0.0.1:7440/healthz" "$TMP_DIR/mock.log" || fail "mock agent did not become ready"

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/cpu-results" DOCUMENT_WORKER_POLL_MS="50" \
DOCUMENT_WORKER_PROCESS_DELAY_MS="1500" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/cpu.log" 2>&1 &
CPU_PID=$!
VECTOR_WORKER_OUTPUT_DIR="$TMP_DIR/vector-results" VECTOR_WORKER_POLL_MS="50" \
VECTOR_WORKER_PROCESS_DELAY_MS="1500" \
  "$BUN_BIN" run workers/vector-bun/src/worker.ts >"$TMP_DIR/vector.log" 2>&1 &
VECTOR_PID=$!
REMOTE_AGENT_OUTPUT_DIR="$TMP_DIR/remote-results" REMOTE_AGENT_WORKER_POLL_MS="50" \
REMOTE_AGENT_ENDPOINT="http://127.0.0.1:7440/invoke" REMOTE_AGENT_PROVIDER_ID="workflow-mock" \
REMOTE_AGENT_BEARER_TOKEN="$REMOTE_TOKEN" \
  "$BUN_BIN" run workers/remote-agent-bun/src/worker.ts >"$TMP_DIR/remote.log" 2>&1 &
REMOTE_PID=$!
WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!

wait_for_log 'id=document-reference-worker' "$TMP_DIR/cpu.log" || fail "cpu worker did not register"
wait_for_log 'id=vector-reference-worker' "$TMP_DIR/vector.log" || fail "vector worker did not register"
wait_for_log 'id=remote-agent-reference-worker' "$TMP_DIR/remote.log" || fail "remote agent worker did not register"
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not register"

WORKFLOW_BODY='{"type":"workflow.run","payload":{"steps":[{"id":"cpu-root","type":"hash.compute","payload":{"data":"workflow cpu root","algorithm":"sha256"}},{"id":"vector-root","type":"vector.dot","payload":{"a":[2,3,-4],"b":[5,-6,7]}},{"id":"remote-join","type":"agent.invoke","payload":{"request_id":"workflow-agent","input":{"prompt":"join after cpu and vector"}},"depends_on":["cpu-root","vector-root"]},{"id":"final-doc","type":"document.process","payload":{"text":"workflow final document","document_id":"workflow-final"},"depends_on":["remote-join"]}]},"priority":0,"max_retries":3}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: workflow-proof-parent-1' --data-binary "$WORKFLOW_BODY")" || fail "workflow enqueue failed"
WORKFLOW_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$WORKFLOW_ID" ]] || fail "workflow enqueue did not return task id"

wait_for_log "parent=$WORKFLOW_ID step=cpu-root" "$TMP_DIR/workflow.log" || fail "workflow did not submit cpu root"
wait_for_log "parent=$WORKFLOW_ID step=vector-root" "$TMP_DIR/workflow.log" || fail "workflow did not submit vector root"
CPU_FIRST="$(sed -n "s/.*parent=$WORKFLOW_ID step=cpu-root task=\([0-9][0-9]*\) replayed=false.*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
VECTOR_FIRST="$(sed -n "s/.*parent=$WORKFLOW_ID step=vector-root task=\([0-9][0-9]*\) replayed=false.*/\1/p" "$TMP_DIR/workflow.log" | head -n1)"
[[ -n "$CPU_FIRST" && -n "$VECTOR_FIRST" ]] || fail "initial child ids were not recorded"

kill -KILL "$WORKFLOW_PID" >/dev/null 2>&1 || fail "could not kill workflow worker for recovery proof"
wait "$WORKFLOW_PID" >/dev/null 2>&1 || true
WORKFLOW_PID=""
sleep 0.8

WORKFLOW_WORKER_OUTPUT_DIR="$TMP_DIR/workflow-results" WORKFLOW_WORKER_POLL_MS="50" \
WORKFLOW_GATEWAY_API_TOKEN="$TOKEN" WORKFLOW_POLL_MS="50" WORKFLOW_MAX_RUN_MS="30000" \
  "$BUN_BIN" run workers/workflow-bun/src/worker.ts >>"$TMP_DIR/workflow.log" 2>&1 &
WORKFLOW_PID=$!
wait_for_log 'id=workflow-reference-worker' "$TMP_DIR/workflow.log" || fail "workflow worker did not re-register"
wait_for_log "parent=$WORKFLOW_ID step=cpu-root task=$CPU_FIRST replayed=true" "$TMP_DIR/workflow.log" || \
  fail "cpu root was not idempotently replayed after workflow restart"
wait_for_log "parent=$WORKFLOW_ID step=vector-root task=$VECTOR_FIRST replayed=true" "$TMP_DIR/workflow.log" || \
  fail "vector root was not idempotently replayed after workflow restart"

parent_snapshot="$(wait_for_task_status "$WORKFLOW_ID" COMPLETED)" || fail "workflow parent did not complete after restart"
if printf '%s' "$parent_snapshot" | grep -E 'payload|locked_by|lease_generation|session' >/dev/null; then
  fail "public workflow snapshot leaked payload or worker internals"
fi

WORKFLOW_RESULT="$TMP_DIR/workflow-results/task-$WORKFLOW_ID.json"
[[ -f "$WORKFLOW_RESULT" ]] || fail "workflow result artifact was not created"
RESULT_PATH="$WORKFLOW_RESULT" GATEWAY_TOKEN="$TOKEN" "$BUN_BIN" -e '
const result = await Bun.file(process.env.RESULT_PATH).json();
if (result.schema_version !== 1 || result.status !== "COMPLETED") process.exit(2);
const expected = new Map([
  ["cpu-root", "hash.compute"],
  ["vector-root", "vector.dot"],
  ["remote-join", "agent.invoke"],
  ["final-doc", "document.process"],
]);
if (!Array.isArray(result.steps) || result.steps.length !== expected.size) process.exit(3);
const ids = new Set();
for (const step of result.steps) {
  if (expected.get(step.id) !== step.type || step.status !== "COMPLETED" || !Number.isSafeInteger(step.task_id)) process.exit(4);
  ids.add(step.task_id);
  const response = await fetch(`http://127.0.0.1:3000/v1/tasks/${step.task_id}`, {
    headers: { Authorization: `Bearer ${process.env.GATEWAY_TOKEN}` },
  });
  const snapshot = await response.json();
  if (response.status !== 200 || snapshot.status !== "COMPLETED" || snapshot.task_name !== step.type) process.exit(5);
}
if (ids.size !== expected.size) process.exit(6);
' || fail "workflow result or child completion validation failed"

if grep -E 'workflow cpu root|join after cpu and vector|workflow final document|workflow-proof-token|workflow-remote-secret' "$WORKFLOW_RESULT" >/dev/null; then
  fail "workflow result copied child payload or secret material"
fi
[[ "$(wc -l < "$TMP_DIR/mock-calls.log" | tr -d ' ')" = "1" ]] || fail "remote workflow step did not execute exactly once"

INVALID_BODY='{"type":"workflow.run","payload":{"steps":[{"id":"a","type":"hash.compute","payload":{"data":"a","algorithm":"sha256"},"depends_on":["b"]},{"id":"b","type":"hash.compute","payload":{"data":"b","algorithm":"sha256"},"depends_on":["a"]}]},"max_retries":0}'
invalid_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: workflow-proof-cycle-1' --data-binary "$INVALID_BODY")" || fail "invalid workflow enqueue failed"
INVALID_ID="$(printf '%s' "$invalid_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_ID" ]] || fail "invalid workflow task id missing"
wait_for_task_status "$INVALID_ID" FAILED >/dev/null || fail "cyclic workflow did not fail closed"
if grep -F "parent=$INVALID_ID step=" "$TMP_DIR/workflow.log" >/dev/null; then
  fail "cyclic workflow submitted a child before validation"
fi
[[ ! -e "$TMP_DIR/workflow-results/task-$INVALID_ID.json" ]] || fail "cyclic workflow produced a result artifact"

echo "Workflow core proof state"
echo "public enqueue -> workflow.run          : OK"
echo "hard capability workflow               : OK"
echo "DAG fan-out cpu + vector               : OK"
echo "join -> remote-agent -> cpu            : OK"
echo "workflow worker SIGKILL                : INJECTED"
echo "parent lease recovery                  : OK"
echo "deterministic child idempotency        : OK"
echo "child task ids after restart           : SAME"
echo "cross-capability child completion      : OK"
echo "parent orchestration exceeds lease     : OK"
echo "workflow result contains topology only : OK"
echo "cyclic DAG                             : FAILED CLOSED BEFORE CHILD"
echo "fenced parent completion               : OK"
echo
echo "Reference workflow core integration: OK (workflow=$WORKFLOW_ID cpu=$CPU_FIRST vector=$VECTOR_FIRST)"

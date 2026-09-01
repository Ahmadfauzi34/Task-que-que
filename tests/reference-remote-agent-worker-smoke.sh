#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
QUEUE_PID=""
BROKER_PID=""
GATEWAY_PID=""
MOCK_PID=""
REMOTE_PID=""
TOKEN="remote-agent-proof-token"
REMOTE_SECRET="reference-remote-secret"

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
  stop_process "$REMOTE_PID"
  stop_process "$MOCK_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "remote agent worker smoke error: $*" >&2
  for log in remote mock gateway broker queue; do
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
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  cat "$log_file" >&2 || true
  return 1
}

wait_for_task_status() {
  local task_id="$1"
  local expected="$2"
  local snapshot=""
  for _ in {1..180}; do
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
command -v wc >/dev/null 2>&1 || fail "wc is required"
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
  --dispatch-interval-ms 50 \
  --session-ttl-ms 5000 \
  --task-lease-ms 600 \
  >"$TMP_DIR/broker.log" 2>&1 &
BROKER_PID=$!

wait_for_url "http://127.0.0.1:7331/readyz" "$TMP_DIR/queue.log" || fail "queue did not become ready"
wait_for_url "http://127.0.0.1:7332/readyz" "$TMP_DIR/broker.log" || fail "worker broker did not become ready"

cd "$ROOT_DIR/gateway"
GATEWAY_API_TOKEN="$TOKEN" \
GATEWAY_MAX_ACTIVE_TASKS="8" \
  "$BUN_BIN" run src/server.ts >"$TMP_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
cd "$ROOT_DIR"
wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log" || fail "gateway did not become ready"

MOCK_AGENT_TOKEN="$REMOTE_SECRET" \
MOCK_AGENT_LOG="$TMP_DIR/mock-calls.log" \
MOCK_AGENT_DELAY_MS="900" \
  "$BUN_BIN" run workers/remote-agent-bun/tests/mock-agent.ts >"$TMP_DIR/mock.log" 2>&1 &
MOCK_PID=$!
wait_for_url "http://127.0.0.1:7440/healthz" "$TMP_DIR/mock.log" || fail "mock remote agent did not become ready"

REMOTE_AGENT_ENDPOINT="http://127.0.0.1:7440/invoke" \
REMOTE_AGENT_PROVIDER_ID="mock-agent" \
REMOTE_AGENT_BEARER_TOKEN="$REMOTE_SECRET" \
REMOTE_AGENT_OUTPUT_DIR="$TMP_DIR/remote-results" \
REMOTE_AGENT_WORKER_POLL_MS="50" \
REMOTE_AGENT_REQUEST_TIMEOUT_MS="5000" \
  "$BUN_BIN" run workers/remote-agent-bun/src/worker.ts >"$TMP_DIR/remote.log" 2>&1 &
REMOTE_PID=$!

for _ in {1..100}; do
  if grep -F 'id=remote-agent-reference-worker' "$TMP_DIR/remote.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
grep -F 'id=remote-agent-reference-worker' "$TMP_DIR/remote.log" >/dev/null || fail "remote agent worker did not register"

CPU_BODY='{"type":"hash.compute","payload":{"data":"must wait for cpu worker","algorithm":"sha256"},"priority":100,"max_retries":0}'
cpu_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: remote-agent-cpu-proof-1' \
  --data-binary "$CPU_BODY")" || fail "public cpu enqueue failed"
CPU_ID="$(printf '%s' "$cpu_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$CPU_ID" ]] || fail "public cpu enqueue did not return task id"

AGENT_BODY='{"type":"agent.invoke","payload":{"request_id":"agent-proof-1","input":{"prompt":"summarize bounded workflow"}},"priority":-100,"max_retries":0}'
agent_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: remote-agent-proof-1' \
  --data-binary "$AGENT_BODY")" || fail "public remote agent enqueue failed"
AGENT_ID="$(printf '%s' "$agent_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$AGENT_ID" ]] || fail "public remote agent enqueue did not return task id"

agent_snapshot="$(wait_for_task_status "$AGENT_ID" COMPLETED)" || fail "remote agent task did not complete"
if printf '%s' "$agent_snapshot" | grep -E 'payload|locked_by|lease_generation|session' >/dev/null; then
  fail "public remote agent snapshot leaked worker or payload internals"
fi

cpu_snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$CPU_ID" \
  -H "Authorization: Bearer $TOKEN")" || fail "cpu snapshot lookup failed"
printf '%s' "$cpu_snapshot" | grep -F '"status":"PENDING"' >/dev/null || \
  fail "cpu task moved without a cpu worker"

RESULT_FILE="$TMP_DIR/remote-results/task-$AGENT_ID.json"
[[ -f "$RESULT_FILE" ]] || fail "remote agent result artifact was not created"
grep -F '"schema_version":1' "$RESULT_FILE" >/dev/null || fail "remote result schema version missing"
grep -F "\"task_id\":$AGENT_ID" "$RESULT_FILE" >/dev/null || fail "remote result task id mismatch"
grep -F '"provider_id":"mock-agent"' "$RESULT_FILE" >/dev/null || fail "remote provider id missing"
grep -F '"request_id":"agent-proof-1"' "$RESULT_FILE" >/dev/null || fail "remote request id missing"
grep -F '"accepted":true' "$RESULT_FILE" >/dev/null || fail "remote result payload missing"
if grep -F "$REMOTE_SECRET" "$RESULT_FILE" >/dev/null; then
  fail "remote bearer token leaked into result artifact"
fi
if grep -F '127.0.0.1:7440' "$RESULT_FILE" >/dev/null; then
  fail "remote endpoint leaked into result artifact"
fi

[[ -f "$TMP_DIR/mock-calls.log" ]] || fail "mock remote agent did not record a call"
CALL_COUNT="$(wc -l <"$TMP_DIR/mock-calls.log" | tr -d '[:space:]')"
[[ "$CALL_COUNT" = "1" ]] || fail "expected exactly one remote call, got $CALL_COUNT"
grep -F "\"task_id\":$AGENT_ID" "$TMP_DIR/mock-calls.log" >/dev/null || fail "mock call task id mismatch"
grep -F '"auth_ok":true' "$TMP_DIR/mock-calls.log" >/dev/null || fail "remote bearer auth was not proven"
grep -F '"idempotency_ok":true' "$TMP_DIR/mock-calls.log" >/dev/null || fail "remote idempotency key was not proven"

INVALID_BODY='{"type":"agent.invoke","payload":{"input":{"prompt":"must not route"},"url":"https://example.invalid"},"priority":0,"max_retries":0}'
invalid_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: remote-agent-proof-2' \
  --data-binary "$INVALID_BODY")" || fail "invalid remote agent enqueue failed"
INVALID_ID="$(printf '%s' "$invalid_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_ID" ]] || fail "invalid remote agent task id missing"
wait_for_task_status "$INVALID_ID" FAILED >/dev/null || fail "task-supplied url did not fail closed"
[[ ! -e "$TMP_DIR/remote-results/task-$INVALID_ID.json" ]] || fail "invalid remote task produced an artifact"

CALL_COUNT_AFTER="$(wc -l <"$TMP_DIR/mock-calls.log" | tr -d '[:space:]')"
[[ "$CALL_COUNT_AFTER" = "1" ]] || fail "invalid task reached the remote endpoint"

echo "Remote agent worker proof state"
echo "public enqueue -> agent.invoke        : OK"
echo "hard capability remote-agent         : OK"
echo "older high-priority cpu task          : PENDING WITHOUT CPU WORKER"
echo "fixed endpoint from worker config     : OK"
echo "task-supplied url/method control       : NONE"
echo "bearer token from worker env           : OK"
echo "deterministic remote idempotency       : OK"
echo "remote call exceeds initial lease      : OK (900ms > 600ms)"
echo "task + session heartbeat               : OK"
echo "bounded atomic result                  : OK"
echo "secret/endpoint persisted              : NONE"
echo "invalid routing payload                : FAILED CLOSED BEFORE REMOTE CALL"
echo "fenced completion                      : OK"
echo
echo "Reference remote agent worker integration: OK (cpu=$CPU_ID agent=$AGENT_ID)"

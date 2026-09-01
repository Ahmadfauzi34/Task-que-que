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
VECTOR_PID=""
DOCUMENT_PID=""
TOKEN="heterogeneous-worker-proof-token"

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
  stop_process "$DOCUMENT_PID"
  stop_process "$VECTOR_PID"
  stop_process "$GATEWAY_PID"
  stop_process "$BROKER_PID"
  stop_process "$QUEUE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "heterogeneous worker smoke error: $*" >&2
  for log in document vector gateway broker queue; do
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
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
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

VECTOR_WORKER_OUTPUT_DIR="$TMP_DIR/vector-results" \
VECTOR_WORKER_POLL_MS="50" \
VECTOR_WORKER_PROCESS_DELAY_MS="900" \
  "$BUN_BIN" run workers/vector-bun/src/worker.ts >"$TMP_DIR/vector.log" 2>&1 &
VECTOR_PID=$!

for _ in {1..100}; do
  if grep -F 'id=vector-reference-worker' "$TMP_DIR/vector.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
grep -F 'id=vector-reference-worker' "$TMP_DIR/vector.log" >/dev/null || fail "vector worker did not register"

CPU_DATA='cpu must wait for cpu worker'
CPU_BODY='{"type":"hash.compute","payload":{"data":"cpu must wait for cpu worker","algorithm":"sha256"},"priority":100,"max_retries":0}'
cpu_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: heterogeneous-cpu-proof-1' \
  --data-binary "$CPU_BODY")" || fail "public cpu enqueue failed"
CPU_ID="$(printf '%s' "$cpu_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$CPU_ID" ]] || fail "public cpu enqueue did not return task id"

VECTOR_BODY='{"type":"vector.dot","payload":{"a":[2,3,-4],"b":[5,-6,7]},"priority":-100,"max_retries":0}'
vector_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: heterogeneous-vector-proof-1' \
  --data-binary "$VECTOR_BODY")" || fail "public vector enqueue failed"
VECTOR_ID="$(printf '%s' "$vector_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$VECTOR_ID" ]] || fail "public vector enqueue did not return task id"

vector_snapshot="$(wait_for_task_status "$VECTOR_ID" COMPLETED)" || fail "vector task did not complete"
if printf '%s' "$vector_snapshot" | grep -E 'payload|locked_by|lease_generation|session' >/dev/null; then
  fail "public vector snapshot leaked worker or payload internals"
fi

cpu_snapshot="$(curl -fsS --max-time 2 "http://127.0.0.1:3000/v1/tasks/$CPU_ID" \
  -H "Authorization: Bearer $TOKEN")" || fail "cpu snapshot lookup failed"
printf '%s' "$cpu_snapshot" | grep -F '"status":"PENDING"' >/dev/null || \
  fail "cpu task moved without a cpu worker"

VECTOR_RESULT="$TMP_DIR/vector-results/task-$VECTOR_ID.json"
[[ -f "$VECTOR_RESULT" ]] || fail "vector result artifact was not created"
grep -F '"schema_version":1' "$VECTOR_RESULT" >/dev/null || fail "vector schema version missing"
grep -F "\"task_id\":$VECTOR_ID" "$VECTOR_RESULT" >/dev/null || fail "vector result task id mismatch"
grep -F '"length":3' "$VECTOR_RESULT" >/dev/null || fail "vector result length mismatch"
grep -F '"dot":-36' "$VECTOR_RESULT" >/dev/null || fail "vector dot result mismatch"
if grep -F '[2,3,-4]' "$VECTOR_RESULT" >/dev/null || grep -F '[5,-6,7]' "$VECTOR_RESULT" >/dev/null; then
  fail "vector result copied source vectors"
fi
[[ ! -e "$TMP_DIR/vector-results/task-$CPU_ID.json" ]] || fail "vector worker processed cpu task"

INVALID_VECTOR_BODY='{"type":"vector.dot","payload":{"a":[1,2],"b":[3]},"priority":0,"max_retries":0}'
invalid_vector_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: heterogeneous-vector-proof-2' \
  --data-binary "$INVALID_VECTOR_BODY")" || fail "invalid vector enqueue failed"
INVALID_VECTOR_ID="$(printf '%s' "$invalid_vector_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_VECTOR_ID" ]] || fail "invalid vector task id missing"
wait_for_task_status "$INVALID_VECTOR_ID" FAILED >/dev/null || fail "invalid vector task did not fail closed"
[[ ! -e "$TMP_DIR/vector-results/task-$INVALID_VECTOR_ID.json" ]] || fail "invalid vector task produced an artifact"

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/cpu-results" \
DOCUMENT_WORKER_POLL_MS="50" \
DOCUMENT_WORKER_PROCESS_DELAY_MS="0" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/document.log" 2>&1 &
DOCUMENT_PID=$!

for _ in {1..100}; do
  if grep -F 'id=document-reference-worker' "$TMP_DIR/document.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
grep -F 'id=document-reference-worker' "$TMP_DIR/document.log" >/dev/null || fail "cpu worker did not register"

cpu_completed="$(wait_for_task_status "$CPU_ID" COMPLETED)" || fail "cpu task did not complete after cpu worker joined"
if printf '%s' "$cpu_completed" | grep -E 'payload|locked_by|lease_generation|session' >/dev/null; then
  fail "public cpu snapshot leaked worker or payload internals"
fi

CPU_RESULT="$TMP_DIR/cpu-results/task-$CPU_ID.json"
[[ -f "$CPU_RESULT" ]] || fail "cpu result artifact was not created"
EXPECTED_CPU_SHA="$(printf '%s' "$CPU_DATA" | sha256sum | awk '{print $1}')"
grep -F '"algorithm":"sha256"' "$CPU_RESULT" >/dev/null || fail "cpu result algorithm mismatch"
grep -F "\"digest\":\"$EXPECTED_CPU_SHA\"" "$CPU_RESULT" >/dev/null || fail "cpu result digest mismatch"
[[ ! -e "$TMP_DIR/cpu-results/task-$VECTOR_ID.json" ]] || fail "cpu worker processed vector task"

echo "Heterogeneous worker proof state"
echo "custom capability vector             : REGISTERED"
echo "older high-priority cpu task         : PENDING WITHOUT CPU WORKER"
echo "lower-priority vector task           : COMPLETED"
echo "hard cpu/vector capability partition : OK"
echo "vector processing exceeds lease      : OK (900ms > 600ms)"
echo "shared task + session heartbeat      : OK"
echo "exact vector.dot handler             : OK"
echo "source vectors not copied            : OK"
echo "invalid vector payload               : FAILED CLOSED"
echo "cpu task resumes with cpu worker     : OK"
echo "cross-worker artifact isolation      : OK"
echo
echo "Reference heterogeneous workers integration: OK (cpu=$CPU_ID vector=$VECTOR_ID)"

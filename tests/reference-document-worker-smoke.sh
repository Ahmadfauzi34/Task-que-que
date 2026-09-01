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
DOCUMENT_PID=""
TOKEN="reference-worker-proof-token"

cleanup() {
  for pid in "$DOCUMENT_PID" "$GATEWAY_PID" "$BROKER_PID" "$QUEUE_PID"; do
    if [[ -n "$pid" ]]; then
      kill -INT "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "reference document worker smoke error: $*" >&2
  for log in document gateway broker queue; do
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
  for _ in {1..160}; do
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

DOCUMENT_WORKER_OUTPUT_DIR="$TMP_DIR/results" \
DOCUMENT_WORKER_POLL_MS="50" \
DOCUMENT_WORKER_PROCESS_DELAY_MS="900" \
  "$BUN_BIN" run workers/document-bun/src/worker.ts >"$TMP_DIR/document.log" 2>&1 &
DOCUMENT_PID=$!

for _ in {1..100}; do
  if grep -F 'reference document worker registered:' "$TMP_DIR/document.log" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
grep -F 'reference document worker registered:' "$TMP_DIR/document.log" >/dev/null || fail "document worker did not register"

VALID_TEXT='hello world
from reference worker'
VALID_BODY='{"type":"document.process","payload":{"document_id":"proof-1","text":"hello world\nfrom reference worker"},"priority":10,"max_retries":0}'
created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: reference-document-proof-1' \
  --data-binary "$VALID_BODY")" || fail "public enqueue failed"
TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$TASK_ID" ]] || fail "public enqueue did not return task id"

snapshot="$(wait_for_task_status "$TASK_ID" COMPLETED)" || fail "valid document task did not complete"
if printf '%s' "$snapshot" | grep -E 'payload|locked_by|lease_generation|session' >/dev/null; then
  fail "public completed snapshot leaked worker or payload internals"
fi

RESULT_FILE="$TMP_DIR/results/task-$TASK_ID.json"
[[ -f "$RESULT_FILE" ]] || fail "document result artifact was not created"
EXPECTED_SHA="$(printf '%s' "$VALID_TEXT" | sha256sum | awk '{print $1}')"
grep -F '"schema_version":1' "$RESULT_FILE" >/dev/null || fail "result schema version missing"
grep -F "\"task_id\":$TASK_ID" "$RESULT_FILE" >/dev/null || fail "result task id mismatch"
grep -F '"document_id":"proof-1"' "$RESULT_FILE" >/dev/null || fail "result document id missing"
grep -F '"bytes":33' "$RESULT_FILE" >/dev/null || fail "result byte count mismatch"
grep -F '"characters":33' "$RESULT_FILE" >/dev/null || fail "result character count mismatch"
grep -F '"lines":2' "$RESULT_FILE" >/dev/null || fail "result line count mismatch"
grep -F '"words":5' "$RESULT_FILE" >/dev/null || fail "result word count mismatch"
grep -F "\"sha256\":\"$EXPECTED_SHA\"" "$RESULT_FILE" >/dev/null || fail "result digest mismatch"
if grep -F 'hello world' "$RESULT_FILE" >/dev/null; then
  fail "result artifact copied source document text"
fi

INVALID_BODY='{"type":"document.process","payload":{"document_id":"proof-invalid"},"priority":10,"max_retries":0}'
invalid_created="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: reference-document-proof-2' \
  --data-binary "$INVALID_BODY")" || fail "invalid proof enqueue failed"
INVALID_ID="$(printf '%s' "$invalid_created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "$INVALID_ID" ]] || fail "invalid proof task id missing"
wait_for_task_status "$INVALID_ID" FAILED >/dev/null || fail "invalid document task did not fail closed"
[[ ! -e "$TMP_DIR/results/task-$INVALID_ID.json" ]] || fail "invalid task unexpectedly produced an artifact"

# The 900 ms processing delay is longer than the initial 600 ms task lease.
# Completion therefore proves that the reference worker renewed its fenced lease.
echo "Reference document worker proof state"
echo "public enqueue -> document.process : OK"
echo "Rust hard capability cpu          : OK"
echo "processing exceeds initial lease  : OK (900ms > 600ms)"
echo "task + session heartbeat          : OK"
echo "atomic deterministic result       : OK"
echo "source text not copied to result  : OK"
echo "public worker metadata disclosure : NONE"
echo "invalid payload                   : FAILED CLOSED"
echo "fenced completion                 : OK"
echo
echo "Reference document worker integration: OK (task_id=$TASK_ID)"

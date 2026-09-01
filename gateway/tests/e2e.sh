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
GATEWAY_API_TOKEN="ci-gateway-secret" \
  bun run src/server.ts \
  >"$TMP_DIR/gateway.log" 2>&1 &
BUN_PID=$!
cd "$ROOT_DIR"

wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log"

health="$(curl -fsS http://127.0.0.1:3000/healthz)"
printf '%s' "$health" | grep -F '"status":"ok"' >/dev/null

unauthorized_status="$(
  curl -sS -o "$TMP_DIR/unauthorized.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Content-Type: application/json' \
    --data-binary '{"type":"document.process","payload":{"document_id":"unauthorized"}}'
)"
test "$unauthorized_status" = "401"

missing_key_status="$(
  curl -sS -o "$TMP_DIR/missing-key.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Authorization: Bearer ci-gateway-secret' \
    -H 'Content-Type: application/json' \
    --data-binary '{"type":"document.process","payload":{"document_id":"missing-key"}}'
)"
test "$missing_key_status" = "400"

IDEMPOTENCY_KEY="ci-e2e-request-1"
TASK_BODY='{"type":"document.process","payload":{"document_id":"e2e"},"priority":10,"max_retries":3}'

created="$(
  curl -fsS -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Authorization: Bearer ci-gateway-secret' \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
printf '%s' "$created" | grep -F '"status":"PENDING"' >/dev/null
printf '%s' "$created" | grep -F '"replayed":false' >/dev/null

TASK_ID="$(printf '%s' "$created" | sed -n 's/.*"task_id":\([0-9][0-9]*\).*/\1/p')"
test -n "$TASK_ID"

replayed="$(
  curl -fsS -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Authorization: Bearer ci-gateway-secret' \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary "$TASK_BODY"
)"
printf '%s' "$replayed" | grep -F "\"task_id\":$TASK_ID" >/dev/null
printf '%s' "$replayed" | grep -F '"replayed":true' >/dev/null

conflict_status="$(
  curl -sS -o "$TMP_DIR/conflict.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Authorization: Bearer ci-gateway-secret' \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    --data-binary '{"type":"document.process","payload":{"document_id":"different"},"priority":10,"max_retries":3}'
)"
test "$conflict_status" = "409"

snapshot="$(
  curl -fsS "http://127.0.0.1:3000/v1/tasks/$TASK_ID" \
    -H 'Authorization: Bearer ci-gateway-secret'
)"
printf '%s' "$snapshot" | grep -F '"task_name":"document.process"' >/dev/null
printf '%s' "$snapshot" | grep -F '"task_type":"cpu"' >/dev/null
printf '%s' "$snapshot" | grep -F '"status":"PENDING"' >/dev/null

if printf '%s' "$snapshot" | grep -F '"payload"' >/dev/null; then
  echo "public task snapshot leaked payload" >&2
  exit 1
fi

if curl -fsS "http://127.0.0.1:3000/v1/tasks/2" \
  -H 'Authorization: Bearer ci-gateway-secret' >/dev/null 2>&1; then
  echo "idempotency replay unexpectedly created task 2" >&2
  exit 1
fi

echo "Bun -> Rust idempotent localhost integration: OK (task_id=$TASK_ID)"

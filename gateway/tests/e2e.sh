#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
RUST_PID=""
BROKER_PID=""
BUN_PID=""

cleanup() {
  if [[ -n "$BUN_PID" ]]; then
    kill "$BUN_PID" >/dev/null 2>&1 || true
    wait "$BUN_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BROKER_PID" ]]; then
    kill -INT "$BROKER_PID" >/dev/null 2>&1 || true
    wait "$BROKER_PID" >/dev/null 2>&1 || true
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

mcp_post() {
  local method="$1"
  local body="$2"
  local name="${3:-}"
  local args=(
    -fsS -X POST http://127.0.0.1:3000/mcp
    -H 'Authorization: Bearer ci-gateway-secret'
    -H 'Content-Type: application/json'
    -H 'Accept: application/json, text/event-stream'
    -H 'MCP-Protocol-Version: 2026-07-28'
    -H "Mcp-Method: $method"
  )
  if [[ -n "$name" ]]; then
    args+=( -H "Mcp-Name: $name" )
  fi
  curl "${args[@]}" --data-binary "$body"
}

cd "$ROOT_DIR"

./target/debug/robust-sinkhorn-queue serve \
  --db "$TMP_DIR/queue.db" \
  >"$TMP_DIR/rust.log" 2>&1 &
RUST_PID=$!
wait_for_url "http://127.0.0.1:7331/readyz" "$TMP_DIR/rust.log"

./target/debug/robust-sinkhorn-worker serve \
  --db "$TMP_DIR/queue.db" \
  >"$TMP_DIR/broker.log" 2>&1 &
BROKER_PID=$!
wait_for_url "http://127.0.0.1:7332/readyz" "$TMP_DIR/broker.log"

curl -fsS -X POST http://127.0.0.1:7332/v1/register \
  -H 'X-Worker-Id: mcp-provider-proof' \
  -H 'X-Worker-Type: cpu' \
  -H 'X-Worker-Capacity: 1' \
  -H 'X-Worker-Tasks: document.process' \
  >"$TMP_DIR/provider-registration.json"

cd "$ROOT_DIR/gateway"
GATEWAY_API_TOKEN="ci-gateway-secret" \
GATEWAY_MAX_ACTIVE_TASKS="1" \
  bun run src/server.ts \
  >"$TMP_DIR/gateway.log" 2>&1 &
BUN_PID=$!
cd "$ROOT_DIR"

wait_for_url "http://127.0.0.1:3000/readyz" "$TMP_DIR/gateway.log"

health="$(curl -fsS http://127.0.0.1:3000/healthz)"
printf '%s' "$health" | grep -F '"status":"ok"' >/dev/null

MCP_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"ci-e2e","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}'

mcp_discover="$(mcp_post server/discover "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$MCP_META}}")"
printf '%s' "$mcp_discover" | grep -F '"supportedVersions":["2026-07-28"]' >/dev/null
printf '%s' "$mcp_discover" | grep -F '"tools":{"listChanged":false}' >/dev/null
if printf '%s' "$mcp_discover" | grep -Fi 'mcp-session-id' >/dev/null; then
  echo "modern MCP discovery unexpectedly exposed a protocol session id" >&2
  exit 1
fi

mcp_tools="$(mcp_post tools/list "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$MCP_META}}")"
printf '%s' "$mcp_tools" | grep -F '"name":"system.capabilities"' >/dev/null
printf '%s' "$mcp_tools" | grep -F '"name":"document.process"' >/dev/null
if printf '%s' "$mcp_tools" | grep -F '"name":"agent.invoke"' >/dev/null; then
  echo "MCP advertised agent.invoke without a live remote-agent provider" >&2
  exit 1
fi

mcp_ready="$(mcp_post tools/call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"system.readiness\",\"arguments\":{},$MCP_META}}" system.readiness)"
printf '%s' "$mcp_ready" | grep -F '"isError":false' >/dev/null
printf '%s' "$mcp_ready" | grep -F '\"queue\":\"ready\"' >/dev/null

# The MCP availability proof is complete. Stop the dummy provider broker so it
# cannot claim the durable task used by the queue/admission assertions below.
kill -INT "$BROKER_PID"
wait "$BROKER_PID"
BROKER_PID=""

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

capacity_status="$(
  curl -sS -o "$TMP_DIR/capacity.json" -w '%{http_code}' \
    -X POST http://127.0.0.1:3000/v1/tasks \
    -H 'Authorization: Bearer ci-gateway-secret' \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: ci-e2e-request-2' \
    --data-binary '{"type":"document.process","payload":{"document_id":"second"},"priority":10,"max_retries":3}'
)"
test "$capacity_status" = "503"
grep -F '"code":"queue_capacity_reached"' "$TMP_DIR/capacity.json" >/dev/null

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

metrics="$(curl -fsS http://127.0.0.1:7331/metricsz)"
printf '%s' "$metrics" | grep -F '"total_tasks":1' >/dev/null
printf '%s' "$metrics" | grep -F '"pending":1' >/dev/null
printf '%s' "$metrics" | grep -F '"runnable":1' >/dev/null
printf '%s' "$metrics" | grep -F '"expired":0' >/dev/null

for forbidden in 'document.process' '"document_id"' '"payload"' '"locked_by"' 'e2e'; do
  if printf '%s' "$metrics" | grep -F "$forbidden" >/dev/null; then
    echo "local metrics leaked task-specific data: $forbidden" >&2
    exit 1
  fi
done

if curl -fsS "http://127.0.0.1:3000/v1/tasks/2" \
  -H 'Authorization: Bearer ci-gateway-secret' >/dev/null 2>&1; then
  echo "capacity rejection unexpectedly created task 2" >&2
  exit 1
fi

echo "Modern MCP stateless Bun -> live provider -> Rust readiness integration: OK"
echo "MCP withheld unavailable remote-agent capability: OK"
echo "Bun -> Rust idempotent localhost integration: OK (task_id=$TASK_ID)"
echo "Rust bounded queue metrics integration: OK"
echo "Durable active-task admission integration: OK (capacity=1)"

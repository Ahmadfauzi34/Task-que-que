#!/usr/bin/env sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
PORT="${TASK_QUEUE_FS_PROOF_PORT:-3101}"
TMP_DIR="$(mktemp -d)"
DELEGATED_ROOT="$TMP_DIR/delegated"
OUTSIDE_ROOT="$TMP_DIR/outside"
TOKEN="termux-filesystem-proof-root"
GATEWAY_PID=""

cleanup() {
  if [ -n "$GATEWAY_PID" ]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'filesystem physical proof failed: %s\n' "$*" >&2
  [ ! -s "$TMP_DIR/gateway.log" ] || tail -n 80 "$TMP_DIR/gateway.log" >&2 || true
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_command curl
require_command grep
require_command sed
require_command mktemp
require_command ln
[ -x "$BUN_BIN" ] || fail "Bun runtime not executable: $BUN_BIN"

mkdir -p "$DELEGATED_ROOT/src" "$OUTSIDE_ROOT"
printf 'physical filesystem proof\n' > "$DELEGATED_ROOT/README.txt"
printf 'export const physical = true;\n' > "$DELEGATED_ROOT/src/index.ts"
printf 'outside secret\n' > "$OUTSIDE_ROOT/secret.txt"
ln -s "$OUTSIDE_ROOT/secret.txt" "$DELEGATED_ROOT/escape-link"

cd "$ROOT_DIR/gateway"
GATEWAY_HOST=127.0.0.1 \
GATEWAY_PORT="$PORT" \
QUEUE_DAEMON_URL=http://127.0.0.1:7431 \
WORKER_BROKER_URL=http://127.0.0.1:7432 \
GATEWAY_UPSTREAM_TIMEOUT_MS=100 \
GATEWAY_API_TOKEN="$TOKEN" \
GATEWAY_FILESYSTEM_ROOT="$DELEGATED_ROOT" \
"$BUN_BIN" run src/server.ts >"$TMP_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!

attempt=1
while [ "$attempt" -le 50 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$GATEWAY_PID" >/dev/null 2>&1 || fail "gateway exited during startup"
  sleep 0.1
  attempt=$((attempt + 1))
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "gateway did not become healthy"

SESSION_JSON="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/capability-sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"depth":5,"authority":0,"scopes":["filesystem.inspect","filesystem.read"],"ttl_seconds":300}')"
SESSION_TOKEN="$(printf '%s' "$SESSION_JSON" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')"
[ -n "$SESSION_TOKEN" ] || fail "signed D5 filesystem session was not issued"

LIST="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/filesystem/list" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"."}')"
printf '%s' "$LIST" | grep -F '"README.txt"' >/dev/null || fail "delegated root listing missing README.txt"
printf '%s' "$LIST" | grep -F "$DELEGATED_ROOT" >/dev/null && fail "absolute delegated root leaked in listing"

READ="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/filesystem/read" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"README.txt"}')"
printf '%s' "$READ" | grep -F 'physical filesystem proof' >/dev/null || fail "in-root read failed"
printf '%s' "$READ" | grep -F "$DELEGATED_ROOT" >/dev/null && fail "absolute delegated root leaked in read result"

STATUS="$(curl -sS -o "$TMP_DIR/parent.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/filesystem/read" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"../outside/secret.txt"}')"
[ "$STATUS" = "403" ] || fail "parent traversal was not rejected"

STATUS="$(curl -sS -o "$TMP_DIR/absolute.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/filesystem/read" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"/etc/passwd"}')"
[ "$STATUS" = "400" ] || fail "absolute path was not rejected"

STATUS="$(curl -sS -o "$TMP_DIR/symlink.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/filesystem/read" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"escape-link"}')"
[ "$STATUS" = "403" ] || fail "outside-root symlink was not rejected"

MCP_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"termux-filesystem-proof","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}'
MCP_LIST="$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$MCP_META}}")"
for tool in filesystem.list filesystem.stat filesystem.read; do
  printf '%s' "$MCP_LIST" | grep -F "\"name\":\"$tool\"" >/dev/null || fail "MCP did not advertise $tool"
done

MCP_READ="$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: filesystem.read' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"filesystem.read\",\"arguments\":{\"path\":\"README.txt\"},$MCP_META}}")"
printf '%s' "$MCP_READ" | grep -F 'physical filesystem proof' >/dev/null || fail "MCP filesystem.read failed"
printf '%s' "$MCP_READ" | grep -F '"isError":false' >/dev/null || fail "MCP filesystem.read returned an error"

printf 'D5 filesystem physical proof state\n'
printf 'signed D5/A0 session              : OK\n'
printf 'server-owned delegated root       : OK\n'
printf 'in-root list/read                 : OK\n'
printf 'parent traversal                  : REJECTED\n'
printf 'absolute path                     : REJECTED\n'
printf 'outside-root symlink              : REJECTED\n'
printf 'absolute root disclosure          : NOT OBSERVED\n'
printf 'MCP filesystem tools              : ADVERTISED\n'
printf 'MCP filesystem.read               : OK\n'
printf '\nD5 scoped read-only filesystem provider: OK\n'

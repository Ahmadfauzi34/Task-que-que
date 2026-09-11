#!/usr/bin/env sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
MUTATOR_BIN="${TASK_QUEUE_FS_MUTATOR_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-fs-mutator}"
PORT="${TASK_QUEUE_FS_MUTATION_PROOF_PORT:-3102}"
TMP_DIR="$(mktemp -d)"
DELEGATED_ROOT="$TMP_DIR/delegated"
OUTSIDE_ROOT="$TMP_DIR/outside"
TOKEN="termux-filesystem-mutation-proof-root"
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
  printf 'filesystem mutation provider proof failed: %s\n' "$*" >&2
  [ ! -s "$TMP_DIR/gateway.log" ] || tail -n 100 "$TMP_DIR/gateway.log" >&2 || true
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_executable() {
  case "$1" in
    */*) [ -x "$1" ] || fail "executable not found: $1" ;;
    *) command -v "$1" >/dev/null 2>&1 || fail "executable not found in PATH: $1" ;;
  esac
}

require_command curl
require_command grep
require_command sed
require_command mktemp
require_executable "$BUN_BIN"
require_executable "$MUTATOR_BIN"

mkdir -p "$DELEGATED_ROOT" "$OUTSIDE_ROOT"
printf 'outside sentinel\n' > "$OUTSIDE_ROOT/sentinel.txt"

"$MUTATOR_BIN" probe --root "$DELEGATED_ROOT" >/dev/null \
  || fail "Rust mutator probe rejected the delegated root"

cd "$ROOT_DIR/gateway"
GATEWAY_HOST=127.0.0.1 \
GATEWAY_PORT="$PORT" \
QUEUE_DAEMON_URL=http://127.0.0.1:7431 \
WORKER_BROKER_URL=http://127.0.0.1:7432 \
GATEWAY_UPSTREAM_TIMEOUT_MS=1000 \
GATEWAY_API_TOKEN="$TOKEN" \
GATEWAY_FILESYSTEM_ROOT="$DELEGATED_ROOT" \
GATEWAY_FILESYSTEM_MUTATOR_BIN="$MUTATOR_BIN" \
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
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null \
  || fail "gateway did not become healthy"

A3_JSON="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/capability-sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"depth":5,"authority":3,"scopes":["filesystem.write","filesystem.mkdir"],"ttl_seconds":300}')"
A3_TOKEN="$(printf '%s' "$A3_JSON" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')"
[ -n "$A3_TOKEN" ] || fail "signed D5/A3 filesystem mutation session was not issued"

A0_JSON="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/capability-sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"depth":5,"authority":0,"scopes":["filesystem.write","filesystem.mkdir"],"ttl_seconds":300}')"
A0_TOKEN="$(printf '%s' "$A0_JSON" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')"
[ -n "$A0_TOKEN" ] || fail "signed D5/A0 control session was not issued"

STATUS="$(curl -sS -o "$TMP_DIR/a0-denied.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/filesystem/mkdir" \
  -H "Authorization: Bearer $A0_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"must-not-exist"}')"
[ "$STATUS" = "403" ] || fail "A0 session was not denied mutation authority"
[ ! -e "$DELEGATED_ROOT/must-not-exist" ] \
  || fail "A0-denied mutation still changed the delegated root"

MKDIR_RESULT="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/filesystem/mkdir" \
  -H "Authorization: Bearer $A3_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"notes"}')"
printf '%s' "$MKDIR_RESULT" | grep -F '"committed":true' >/dev/null \
  || fail "direct filesystem.mkdir did not commit"
[ -d "$DELEGATED_ROOT/notes" ] || fail "Rust mutator did not create notes directory"

WRITE_RESULT="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/filesystem/write" \
  -H "Authorization: Bearer $A3_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"notes/direct.txt","content":"direct mutation proof\n"}')"
printf '%s' "$WRITE_RESULT" | grep -F '"durability":"synced"' >/dev/null \
  || fail "direct filesystem.write did not prove synced durability"
grep -F 'direct mutation proof' "$DELEGATED_ROOT/notes/direct.txt" >/dev/null \
  || fail "direct filesystem.write did not reach the delegated root"
printf '%s' "$WRITE_RESULT" | grep -F "$DELEGATED_ROOT" >/dev/null \
  && fail "absolute delegated root leaked from direct mutation result"

STATUS="$(curl -sS -o "$TMP_DIR/ambiguous.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/v1/filesystem/write" \
  -H "Authorization: Bearer $A3_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"path":"notes//ambiguous.txt","content":"blocked"}')"
[ "$STATUS" = "400" ] || fail "ambiguous mutation path was not rejected before Rust mutation"
[ ! -e "$DELEGATED_ROOT/notes/ambiguous.txt" ] \
  || fail "rejected ambiguous mutation path changed the delegated root"

MCP_META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"termux-filesystem-mutation-proof","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}'

MCP_LIST="$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $A3_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$MCP_META}}")"
for tool in filesystem.write filesystem.mkdir; do
  printf '%s' "$MCP_LIST" | grep -F "\"name\":\"$tool\"" >/dev/null \
    || fail "MCP did not advertise live authorized $tool"
done

MCP_A0_LIST="$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $A0_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$MCP_META}}")"
for tool in filesystem.write filesystem.mkdir; do
  if printf '%s' "$MCP_A0_LIST" | grep -F "\"name\":\"$tool\"" >/dev/null; then
    fail "MCP advertised $tool to an A0 session"
  fi
done

MCP_WRITE="$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $A3_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: filesystem.write' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"filesystem.write\",\"arguments\":{\"path\":\"notes/mcp.txt\",\"content\":\"MCP mutation proof\\n\"},$MCP_META}}")"
printf '%s' "$MCP_WRITE" | grep -F '"isError":false' >/dev/null \
  || fail "MCP filesystem.write returned an error"
printf '%s' "$MCP_WRITE" | grep -F '"durability":"synced"' >/dev/null \
  || fail "MCP filesystem.write did not preserve durability result"
grep -F 'MCP mutation proof' "$DELEGATED_ROOT/notes/mcp.txt" >/dev/null \
  || fail "MCP filesystem.write did not reach the Rust mutation substrate"
printf '%s' "$MCP_WRITE" | grep -F "$DELEGATED_ROOT" >/dev/null \
  && fail "absolute delegated root leaked through MCP mutation result"

[ "$(cat "$OUTSIDE_ROOT/sentinel.txt")" = "outside sentinel" ] \
  || fail "outside-root sentinel changed"

printf 'D5 filesystem mutation provider proof state\n'
printf 'signed D5/A3 session                 : OK\n'
printf 'A0 mutation attempt                  : REJECTED BEFORE EFFECT\n'
printf 'server-owned delegated root          : OK\n'
printf 'server-owned Rust mutator             : PROBED\n'
printf 'direct mkdir/write                    : COMMITTED + SYNCED\n'
printf 'ambiguous relative path               : REJECTED\n'
printf 'absolute root disclosure              : NOT OBSERVED\n'
printf 'MCP mutation tools A3                 : ADVERTISED\n'
printf 'MCP mutation tools A0                 : WITHHELD\n'
printf 'MCP filesystem.write                  : RUST-BACKED OK\n'
printf 'outside-root mutation                 : NOT OBSERVED\n'
printf '\nD5 Rust-backed filesystem mutation provider: OK\n'

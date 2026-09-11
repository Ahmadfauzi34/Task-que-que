#!/data/data/com.termux/files/usr/bin/sh
set -eu

DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
TOKEN_FILE="$DATA_DIR/gateway-token"
PUBLIC_URL_FILE="$DATA_DIR/public-url"
LOCAL_ORIGIN="${TASK_QUEUE_AGENT_LOCAL_ORIGIN:-http://127.0.0.1:3000}"
TTL_SECONDS="${TASK_QUEUE_AGENT_TTL_SECONDS:-900}"

fail() {
  printf 'mcp agent handoff error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: termux-mcp-agent-handoff.sh <depth 0..6> <authority 0..4> <scope> [scope ...]

Example:
  sh ops/termux-mcp-agent-handoff.sh 5 1 process.command.repo.inspect

Environment:
  TASK_QUEUE_DATA_DIR            reference-machine data directory
  TASK_QUEUE_AGENT_LOCAL_ORIGIN  local gateway origin (default http://127.0.0.1:3000)
  TASK_QUEUE_AGENT_TTL_SECONDS   signed session TTL, 60..86400 (default 900)
EOF
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_uint_range() {
  name="$1"
  value="$2"
  min="$3"
  max="$4"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be an integer between $min and $max" ;;
  esac
  [ "$value" -ge "$min" ] 2>/dev/null && [ "$value" -le "$max" ] 2>/dev/null \
    || fail "$name must be an integer between $min and $max"
}

[ "$#" -ge 3 ] || usage
DEPTH="$1"
AUTHORITY="$2"
shift 2

validate_uint_range depth "$DEPTH" 0 6
validate_uint_range authority "$AUTHORITY" 0 4
validate_uint_range TASK_QUEUE_AGENT_TTL_SECONDS "$TTL_SECONDS" 60 86400
[ "$#" -le 64 ] || fail "at most 64 scopes are allowed"

require_command curl
require_command grep
require_command sed
require_command mktemp
require_command chmod

[ -s "$TOKEN_FILE" ] || fail "gateway root token not found: $TOKEN_FILE"
[ -s "$PUBLIC_URL_FILE" ] || fail "public URL not found: $PUBLIC_URL_FILE; start the reference machine with tunnel enabled first"
chmod 600 "$TOKEN_FILE"
ROOT_TOKEN="$(cat "$TOKEN_FILE")"
[ -n "$ROOT_TOKEN" ] || fail "gateway root token is empty"

PUBLIC_ORIGIN="$(sed -n '1p' "$PUBLIC_URL_FILE")"
case "$PUBLIC_ORIGIN" in
  https://*) ;;
  *) fail "public URL must use https://" ;;
esac
case "$PUBLIC_ORIGIN" in
  *[[:space:]]*) fail "public URL contains whitespace" ;;
esac
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
MCP_URL="$PUBLIC_ORIGIN/mcp"

SCOPES_JSON=""
SCOPES_DISPLAY=""
COUNT=0
for SCOPE in "$@"; do
  printf '%s' "$SCOPE" | grep -Eq '^[A-Za-z0-9*][A-Za-z0-9._:/*-]*$' \
    || fail "invalid capability scope: $SCOPE"
  [ "${#SCOPE}" -le 128 ] || fail "capability scope exceeds 128 characters: $SCOPE"
  COUNT=$((COUNT + 1))
  if [ -n "$SCOPES_JSON" ]; then
    SCOPES_JSON="$SCOPES_JSON,"
    SCOPES_DISPLAY="$SCOPES_DISPLAY,"
  fi
  SCOPES_JSON="$SCOPES_JSON\"$SCOPE\""
  SCOPES_DISPLAY="$SCOPES_DISPLAY$SCOPE"
done
[ "$COUNT" -gt 0 ] || fail "at least one scope is required"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup 0

HEALTH_STATUS="$(curl -sS --max-time 3 -o "$TMP_DIR/health.json" -w '%{http_code}' "$LOCAL_ORIGIN/healthz" || true)"
[ "$HEALTH_STATUS" = "200" ] || fail "local gateway is not healthy at $LOCAL_ORIGIN (HTTP ${HEALTH_STATUS:-000})"

REQUEST_BODY="{\"depth\":$DEPTH,\"authority\":$AUTHORITY,\"scopes\":[$SCOPES_JSON],\"ttl_seconds\":$TTL_SECONDS}"
SESSION_STATUS="$(
  curl -sS --max-time 10 \
    -o "$TMP_DIR/session.json" \
    -w '%{http_code}' \
    -X POST "$LOCAL_ORIGIN/v1/capability-sessions" \
    -H "Authorization: Bearer $ROOT_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "$REQUEST_BODY" || true
)"
[ "$SESSION_STATUS" = "201" ] || {
  [ ! -s "$TMP_DIR/session.json" ] || cat "$TMP_DIR/session.json" >&2 || true
  fail "capability session issuance failed with HTTP ${SESSION_STATUS:-000}"
}

SESSION_TOKEN="$(sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p' "$TMP_DIR/session.json")"
SESSION_ID="$(sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' "$TMP_DIR/session.json")"
EXPIRES_AT="$(sed -n 's/.*"expires_at":\([0-9][0-9]*\).*/\1/p' "$TMP_DIR/session.json")"

case "$SESSION_TOKEN" in
  tqq1.*) ;;
  *) fail "gateway returned an invalid capability session token" ;;
esac
[ -n "$SESSION_ID" ] || fail "gateway response did not include session_id"
[ -n "$EXPIRES_AT" ] || fail "gateway response did not include expires_at"

printf 'MCP_AGENT_HANDOFF_V1\n'
printf 'mcp_url=%s\n' "$MCP_URL"
printf 'authorization=Bearer %s\n' "$SESSION_TOKEN"
printf 'session_id=%s\n' "$SESSION_ID"
printf 'expires_at=%s\n' "$EXPIRES_AT"
printf 'grant_depth=%s\n' "$DEPTH"
printf 'grant_authority=%s\n' "$AUTHORITY"
printf 'grant_scopes=%s\n' "$SCOPES_DISPLAY"
printf 'root_token_disclosed=NO\n'

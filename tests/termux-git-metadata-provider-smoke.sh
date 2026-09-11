#!/usr/bin/env sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
PORT="${TASK_QUEUE_GIT_PROOF_PORT:-3103}"
TMP_DIR="$(mktemp -d)"
REPOSITORY="$TMP_DIR/repository"
TOKEN="termux-git-metadata-proof-root"
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
  printf 'git metadata provider proof failed: %s\n' "$*" >&2
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
require_command git
require_command readlink
require_executable "$BUN_BIN"

GIT_BIN="${TASK_QUEUE_GIT_BIN:-$(command -v git)}"
GIT_BIN="$(readlink -f "$GIT_BIN")"
require_executable "$GIT_BIN"

mkdir -p "$REPOSITORY"
"$GIT_BIN" -C "$REPOSITORY" init -q
printf 'first\n' > "$REPOSITORY/README.txt"
"$GIT_BIN" -C "$REPOSITORY" add README.txt
"$GIT_BIN" -C "$REPOSITORY" \
  -c user.name='Task Queue Proof' \
  -c user.email='proof@example.invalid' \
  commit -q -m 'first'
FIRST_SHA="$("$GIT_BIN" -C "$REPOSITORY" rev-parse HEAD)"

printf 'second\n' >> "$REPOSITORY/README.txt"
"$GIT_BIN" -C "$REPOSITORY" add README.txt
"$GIT_BIN" -C "$REPOSITORY" \
  -c user.name='Task Queue Proof' \
  -c user.email='proof@example.invalid' \
  commit -q -m 'second'
SECOND_SHA="$("$GIT_BIN" -C "$REPOSITORY" rev-parse HEAD)"
BRANCH="$("$GIT_BIN" -C "$REPOSITORY" symbolic-ref --short HEAD)"
"$GIT_BIN" -C "$REPOSITORY" tag proof-v1 "$FIRST_SHA"

SENTINEL="$TMP_DIR/external-command-ran"
HELPER="$TMP_DIR/forbidden-helper.sh"
cat > "$HELPER" <<EOF
#!/usr/bin/env sh
printf 'executed\n' > "$SENTINEL"
exit 99
EOF
chmod +x "$HELPER"

# These repository-controlled settings are intentionally hostile. The metadata
# provider must not exercise working-tree/filter/pager execution surfaces.
"$GIT_BIN" -C "$REPOSITORY" config core.fsmonitor "$HELPER"
"$GIT_BIN" -C "$REPOSITORY" config core.pager "$HELPER"
"$GIT_BIN" -C "$REPOSITORY" config diff.external "$HELPER"
"$GIT_BIN" -C "$REPOSITORY" config log.showSignature true

REPOSITORY="$(CDPATH= cd "$REPOSITORY" && pwd -P)"

cd "$ROOT_DIR/gateway"
GATEWAY_HOST=127.0.0.1 \
GATEWAY_PORT="$PORT" \
QUEUE_DAEMON_URL=http://127.0.0.1:7431 \
WORKER_BROKER_URL=http://127.0.0.1:7432 \
GATEWAY_UPSTREAM_TIMEOUT_MS=500 \
GATEWAY_API_TOKEN="$TOKEN" \
GATEWAY_GIT_REPOSITORY="$REPOSITORY" \
GATEWAY_GIT_BIN="$GIT_BIN" \
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

SESSION_JSON="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/capability-sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"depth":5,"authority":0,"scopes":["git.inspect"],"ttl_seconds":300}')"
SESSION_TOKEN="$(printf '%s' "$SESSION_JSON" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')"
[ -n "$SESSION_TOKEN" ] || fail "signed D5/A0 git.inspect session was not issued"

DENIED_JSON="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/capability-sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"depth":5,"authority":0,"scopes":[],"ttl_seconds":300}')"
DENIED_TOKEN="$(printf '%s' "$DENIED_JSON" | sed -n 's/.*"session_token":"\([^"]*\)".*/\1/p')"
[ -n "$DENIED_TOKEN" ] || fail "control session was not issued"

STATUS="$(curl -sS -o "$TMP_DIR/denied.json" -w '%{http_code}' \
  -H "Authorization: Bearer $DENIED_TOKEN" \
  "http://127.0.0.1:$PORT/v1/git/head")"
[ "$STATUS" = "403" ] || fail "missing git.inspect scope was not denied"

HEAD_JSON="$(curl -fsS \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://127.0.0.1:$PORT/v1/git/head")"
printf '%s' "$HEAD_JSON" | grep -F "\"head\":\"$SECOND_SHA\"" >/dev/null \
  || fail "git.head did not return current HEAD"
printf '%s' "$HEAD_JSON" | grep -F "\"branch\":\"$BRANCH\"" >/dev/null \
  || fail "git.head did not return symbolic branch"

LOG_JSON="$(curl -fsS \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://127.0.0.1:$PORT/v1/git/log")"
printf '%s' "$LOG_JSON" | grep -F "$SECOND_SHA" >/dev/null \
  || fail "git.log missing current commit"
printf '%s' "$LOG_JSON" | grep -F "$FIRST_SHA" >/dev/null \
  || fail "git.log missing parent commit"

REFS_JSON="$(curl -fsS \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://127.0.0.1:$PORT/v1/git/refs")"
printf '%s' "$REFS_JSON" | grep -F "refs/heads/$BRANCH" >/dev/null \
  || fail "git.refs missing local branch"
printf '%s' "$REFS_JSON" | grep -F 'refs/tags/proof-v1' >/dev/null \
  || fail "git.refs missing local tag"

CAPS="$(curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/v1/capabilities")"
printf '%s' "$CAPS" | grep -F '"git_metadata_reachable":true' >/dev/null \
  || fail "capability runtime did not report Git metadata provider reachable"
for capability in git.head git.log git.refs; do
  printf '%s' "$CAPS" | grep -F "\"name\":\"$capability\"" >/dev/null \
    || fail "capability inventory missing $capability"
done

ALL_RESULTS="$HEAD_JSON$LOG_JSON$REFS_JSON"
printf '%s' "$ALL_RESULTS" | grep -F "$REPOSITORY" >/dev/null \
  && fail "absolute repository path leaked through public results"
printf '%s' "$ALL_RESULTS" | grep -F "$GIT_BIN" >/dev/null \
  && fail "Git binary path leaked through public results"

STATUS="$(curl -sS -o "$TMP_DIR/query.json" -w '%{http_code}' \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://127.0.0.1:$PORT/v1/git/log?max=999")"
[ "$STATUS" = "400" ] || fail "caller-controlled Git query parameter was not rejected"

[ ! -e "$SENTINEL" ] || fail "repository-controlled external Git helper was executed"

printf 'D5 Git metadata provider proof state\n'
printf 'signed D5/A0 git.inspect session      : OK\n'
printf 'missing git.inspect scope             : REJECTED BEFORE PROVIDER\n'
printf 'server-owned repository identity      : OK\n'
printf 'server-owned Git binary               : OK\n'
printf 'git.head                              : OK\n'
printf 'git.log bounded commit graph          : OK\n'
printf 'git.refs bounded local refs           : OK\n'
printf 'caller-selected Git arguments         : REJECTED\n'
printf 'repository/binary path disclosure     : NOT OBSERVED\n'
printf 'repository external helper execution  : NOT OBSERVED\n'
printf '\nD5 bounded Git metadata provider: OK\n'

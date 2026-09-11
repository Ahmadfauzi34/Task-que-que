#!/usr/bin/env sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
HELPER_BIN="${TASK_QUEUE_PROCESS_EXEC_BIN:-}"

case "$BUN_BIN" in
  */*) [ -x "$BUN_BIN" ] || {
    printf 'process helper integration smoke failed: Bun executable not found: %s\n' "$BUN_BIN" >&2
    exit 1
  } ;;
  *) command -v "$BUN_BIN" >/dev/null 2>&1 || {
    printf 'process helper integration smoke failed: Bun executable not found in PATH: %s\n' "$BUN_BIN" >&2
    exit 1
  } ;;
esac

[ -n "$HELPER_BIN" ] || {
  printf 'process helper integration smoke failed: TASK_QUEUE_PROCESS_EXEC_BIN is required\n' >&2
  exit 1
}
[ -x "$HELPER_BIN" ] || {
  printf 'process helper integration smoke failed: helper is not executable: %s\n' "$HELPER_BIN" >&2
  exit 1
}

cd "$ROOT_DIR/gateway"
TEST_LOG="$(mktemp "${TMPDIR:-/tmp}/tqq-process-helper-test.XXXXXX")"
cleanup() {
  rm -f "$TEST_LOG"
}
trap cleanup EXIT INT TERM

set +e
TASK_QUEUE_PROCESS_EXEC_BIN="$HELPER_BIN" \
  "$BUN_BIN" test ./tests/process_helper_integration.integration.ts \
  >"$TEST_LOG" 2>&1
TEST_STATUS=$?
set -e

cat "$TEST_LOG"

if [ "$TEST_STATUS" -ne 0 ] || ! grep -Eq '(^|[[:space:]])0 fail([[:space:]]|$)' "$TEST_LOG"; then
  printf 'process helper integration smoke failed: Bun integration proof did not report zero failures\n' >&2
  exit 1
fi

printf 'Registered process fd-bound integration proof state\n'
printf 'registry -> Rust helper                  : OK\n'
printf 'target execution                        : FD-BOUND\n'
printf 'target cwd                              : FD-BOUND\n'
printf 'target environment                      : SCRUBBED\n'
printf 'fixed server-owned argv                 : OK\n'
printf 'bounded output overflow                 : PROCESS GROUP KILLED\n'
printf 'server-owned timeout                    : PROCESS GROUP KILLED\n'
printf 'AbortSignal cancellation                : PROCESS GROUP KILLED\n'
printf 'descendant survival after termination   : NOT OBSERVED\n'
printf 'public capability / MCP exposure        : ABSENT\n'
printf '\nRegistered process helper integration: OK\n'

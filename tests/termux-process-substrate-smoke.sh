#!/usr/bin/env sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"

case "$BUN_BIN" in
  */*) [ -x "$BUN_BIN" ] || {
    printf 'registered process substrate smoke failed: Bun executable not found: %s\n' "$BUN_BIN" >&2
    exit 1
  } ;;
  *) command -v "$BUN_BIN" >/dev/null 2>&1 || {
    printf 'registered process substrate smoke failed: Bun executable not found in PATH: %s\n' "$BUN_BIN" >&2
    exit 1
  } ;;
esac

cd "$ROOT_DIR/gateway"
"$BUN_BIN" test \
  tests/process_config.test.ts \
  tests/process_substrate.test.ts

printf 'Registered process policy substrate proof state\n'
printf 'server-owned registry path              : BOUNDED\n'
printf 'registry final symlink                  : REJECTED\n'
printf 'registered executable identity          : CANONICAL NATIVE ELF\n'
printf 'registered cwd identity                 : CANONICAL\n'
printf 'server-owned fd-bound helper config      : BOUNDED\n'
printf 'writable-root registry overlap          : REJECTED\n'
printf 'writable-root binary overlap            : REJECTED\n'
printf 'writable-root cwd overlap               : REJECTED\n'
printf 'writable-root helper overlap            : REJECTED\n'
printf 'unregistered command                    : REJECTED PRE-EXEC\n'
printf 'pre-spawn cancellation                  : REJECTED PRE-EXEC\n'
printf 'missing helper                          : FAIL CLOSED\n'
printf 'fixed HTTP projection                   : PROVEN SEPARATELY\n'
printf 'MCP process exposure                    : ABSENT\n'
printf '\nInternal registered process policy substrate: OK\n'
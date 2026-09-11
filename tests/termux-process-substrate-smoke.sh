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

printf 'Registered process substrate proof state\n'
printf 'server-owned registry path              : BOUNDED\n'
printf 'registry final symlink                  : REJECTED\n'
printf 'registered executable identity          : CANONICAL\n'
printf 'registered cwd identity                 : CANONICAL\n'
printf 'writable-root registry overlap          : REJECTED\n'
printf 'writable-root binary overlap            : REJECTED\n'
printf 'writable-root cwd overlap               : REJECTED\n'
printf 'unregistered command                    : REJECTED\n'
printf 'caller environment inheritance          : SCRUBBED\n'
printf 'fixed argv/cwd execution                : OK\n'
printf 'bounded output overflow                 : KILLED\n'
printf 'server-owned timeout                    : KILLED\n'
printf 'public capability / MCP exposure        : ABSENT\n'
printf '\nInternal registered process substrate: OK\n'

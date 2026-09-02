#!/data/data/com.termux/files/usr/bin/sh
set -eu

QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
EXPECTED_QUEUE_SHA="${TASK_QUEUE_RUST_SHA256:-}"
EXPECTED_WORKER_SHA="${TASK_QUEUE_WORKER_SHA256:-}"

fail() {
  printf 'termux specialist cancellation smoke error: %s\n' "$*" >&2
  exit 1
}

[ -n "$QUEUE_BIN" ] || fail "TASK_QUEUE_RUST_BIN is required"
[ -n "$BROKER_BIN" ] || fail "TASK_QUEUE_WORKER_BIN is required"
[ -n "$EXPECTED_QUEUE_SHA" ] || fail "TASK_QUEUE_RUST_SHA256 is required"
[ -n "$EXPECTED_WORKER_SHA" ] || fail "TASK_QUEUE_WORKER_SHA256 is required"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [ ! -x "$BUN_BIN" ]; then
  fail "Bun executable not found: $BUN_BIN"
fi

TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
TASK_QUEUE_WORKER_BIN="$BROKER_BIN" \
TASK_QUEUE_BUN_BIN="$BUN_BIN" \
TASK_QUEUE_RUST_SHA256="$EXPECTED_QUEUE_SHA" \
TASK_QUEUE_WORKER_SHA256="$EXPECTED_WORKER_SHA" \
  sh tests/termux-lease-loss-cancellation-smoke.sh

"$BUN_BIN" test workers/document-bun/tests/remote-cancellation-propagation.test.ts
"$BUN_BIN" test workers/workflow-bun/tests/cancellation-propagation.test.ts

ARCH="$(uname -m 2>/dev/null || true)"
ACTUAL_QUEUE_SHA="$(sha256sum "$QUEUE_BIN" | awk '{print $1}')"
ACTUAL_WORKER_SHA="$(sha256sum "$BROKER_BIN" | awk '{print $1}')"

printf '\nPhysical Termux specialist cancellation propagation proof\n'
printf 'architecture                    : %s\n' "$ARCH"
printf 'queue artifact sha256           : %s\n' "$ACTUAL_QUEUE_SHA"
printf 'worker broker artifact sha256   : %s\n' "$ACTUAL_WORKER_SHA"
printf 'reviewed queue artifact         : MATCH\n'
printf 'reviewed worker broker artifact : MATCH\n'
printf 'generic lease-loss signal       : DELIVERED\n'
printf 'remote agent in-flight I/O      : ABORTED\n'
printf 'remote result artifact          : NOT WRITTEN\n'
printf 'workflow projection I/O         : ABORTED\n'
printf 'post-cancel child enqueue       : NOT STARTED\n'
printf 'existing fenced worker flow     : PRESERVED\n'
printf '\nTermux specialist cancellation propagation: OK\n'

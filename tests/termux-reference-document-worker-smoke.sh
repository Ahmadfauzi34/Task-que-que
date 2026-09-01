#!/data/data/com.termux/files/usr/bin/sh
set -eu

QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-bun}"
EXPECTED_QUEUE_SHA="${TASK_QUEUE_RUST_SHA256:-}"
EXPECTED_WORKER_SHA="${TASK_QUEUE_WORKER_SHA256:-}"

fail() {
  printf 'termux reference document worker smoke error: %s\n' "$*" >&2
  exit 1
}

validate_sha() {
  label="$1"
  value="$2"
  case "$value" in
    *[!0-9a-fA-F]*|'') fail "$label must be a hexadecimal SHA-256 digest" ;;
  esac
  [ "${#value}" -eq 64 ] || fail "$label must contain exactly 64 hexadecimal characters"
}

command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v awk >/dev/null 2>&1 || fail "awk is required"
command -v bash >/dev/null 2>&1 || fail "bash is required"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [ ! -x "$BUN_BIN" ]; then
  fail "Bun executable not found: $BUN_BIN"
fi
[ -n "$QUEUE_BIN" ] || fail "TASK_QUEUE_RUST_BIN is required"
[ -n "$BROKER_BIN" ] || fail "TASK_QUEUE_WORKER_BIN is required"
[ -x "$QUEUE_BIN" ] || fail "queue binary is not executable: $QUEUE_BIN"
[ -x "$BROKER_BIN" ] || fail "worker broker binary is not executable: $BROKER_BIN"
validate_sha TASK_QUEUE_RUST_SHA256 "$EXPECTED_QUEUE_SHA"
validate_sha TASK_QUEUE_WORKER_SHA256 "$EXPECTED_WORKER_SHA"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; physical proof targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found"

ACTUAL_QUEUE_SHA="$(sha256sum "$QUEUE_BIN" | awk '{print $1}')"
ACTUAL_WORKER_SHA="$(sha256sum "$BROKER_BIN" | awk '{print $1}')"
[ "$ACTUAL_QUEUE_SHA" = "$EXPECTED_QUEUE_SHA" ] || fail "queue binary checksum does not match reviewed artifact"
[ "$ACTUAL_WORKER_SHA" = "$EXPECTED_WORKER_SHA" ] || fail "worker broker checksum does not match reviewed artifact"

TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
TASK_QUEUE_WORKER_BIN="$BROKER_BIN" \
TASK_QUEUE_BUN_BIN="$BUN_BIN" \
  bash tests/reference-document-worker-smoke.sh

printf '\nPhysical Termux reference worker proof\n'
printf 'architecture                    : %s\n' "$ARCH"
printf 'queue artifact sha256           : %s\n' "$ACTUAL_QUEUE_SHA"
printf 'worker broker artifact sha256   : %s\n' "$ACTUAL_WORKER_SHA"
printf 'reviewed queue artifact         : MATCH\n'
printf 'reviewed worker broker artifact : MATCH\n'
printf 'Bun reference worker            : EXECUTED\n'
printf '\nTermux reference document worker: OK\n'

#!/data/data/com.termux/files/usr/bin/sh
set -eu

QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-}"
WORKER_BIN="${TASK_QUEUE_WORKER_BIN:-}"
EXPECTED_QUEUE_SHA="${TASK_QUEUE_RUST_SHA256:-}"
EXPECTED_WORKER_SHA="${TASK_QUEUE_WORKER_SHA256:-}"

fail() {
  printf 'termux worker protocol smoke error: %s\n' "$*" >&2
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
[ -n "$QUEUE_BIN" ] || fail "TASK_QUEUE_RUST_BIN is required"
[ -n "$WORKER_BIN" ] || fail "TASK_QUEUE_WORKER_BIN is required"
[ -x "$QUEUE_BIN" ] || fail "queue binary is not executable: $QUEUE_BIN"
[ -x "$WORKER_BIN" ] || fail "worker binary is not executable: $WORKER_BIN"
validate_sha TASK_QUEUE_RUST_SHA256 "$EXPECTED_QUEUE_SHA"
validate_sha TASK_QUEUE_WORKER_SHA256 "$EXPECTED_WORKER_SHA"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; physical proof targets Android ARM64" ;;
esac
[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found"

ACTUAL_QUEUE_SHA="$(sha256sum "$QUEUE_BIN" | awk '{print $1}')"
ACTUAL_WORKER_SHA="$(sha256sum "$WORKER_BIN" | awk '{print $1}')"
[ "$ACTUAL_QUEUE_SHA" = "$EXPECTED_QUEUE_SHA" ] || fail "queue binary checksum does not match reviewed artifact"
[ "$ACTUAL_WORKER_SHA" = "$EXPECTED_WORKER_SHA" ] || fail "worker binary checksum does not match reviewed artifact"

TASK_QUEUE_RUST_BIN="$QUEUE_BIN" \
TASK_QUEUE_WORKER_BIN="$WORKER_BIN" \
sh tests/worker-protocol-smoke.sh

printf '\nPhysical Termux worker proof\n'
printf 'architecture                    : %s\n' "$ARCH"
printf 'queue artifact sha256           : %s\n' "$ACTUAL_QUEUE_SHA"
printf 'worker artifact sha256          : %s\n' "$ACTUAL_WORKER_SHA"
printf 'reviewed queue artifact         : MATCH\n'
printf 'reviewed worker artifact        : MATCH\n'
printf '\nTermux worker protocol: OK\n'

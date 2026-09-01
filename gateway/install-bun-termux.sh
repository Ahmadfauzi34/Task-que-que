#!/data/data/com.termux/files/usr/bin/sh
set -eu

BUN_VERSION="${TASK_QUEUE_BUN_VERSION:-1.4.0}"
ASSET="bun-linux-aarch64-android.zip"
INSTALL_DIR="${TASK_QUEUE_BUN_INSTALL_DIR:-$HOME/.local/lib/task-queue-bun/${BUN_VERSION}}"
BIN_DIR="${TASK_QUEUE_BUN_BIN_DIR:-$HOME/.local/bin}"
DEST="${INSTALL_DIR}/bun"
LAUNCHER="${BIN_DIR}/task-queue-bun"

fail() {
  printf 'bun install error: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required (Termux: pkg install curl)"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required (Termux: pkg install coreutils)"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required (Termux: pkg install coreutils)"
command -v unzip >/dev/null 2>&1 || fail "unzip is required (Termux: pkg install unzip)"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; this installer currently supports Android ARM64 only" ;;
esac

[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found at /system/bin/linker64"

case "$BUN_VERSION" in
  1.4.0)
    EXPECTED_SHA256="42544d7438bb92c7e7df7d30b9a5858cb7a834636608e5b850f59138283567fc"
    ;;
  *)
    EXPECTED_SHA256="${TASK_QUEUE_BUN_SHA256:-}"
    [ -n "$EXPECTED_SHA256" ] || fail "unrecognized Bun version '$BUN_VERSION'; set TASK_QUEUE_BUN_SHA256 to the official release asset SHA256"
    ;;
esac

case "$EXPECTED_SHA256" in
  *[!0-9a-fA-F]*|'') fail "TASK_QUEUE_BUN_SHA256 must be a hexadecimal SHA256 digest" ;;
esac
[ "${#EXPECTED_SHA256}" -eq 64 ] || fail "TASK_QUEUE_BUN_SHA256 must contain exactly 64 hexadecimal characters"

BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

printf 'Installing Bun %s Android ARM64 runtime for task-queue gateway...\n' "$BUN_VERSION"
cd "$TMP_DIR"

curl -fL --retry 3 --retry-delay 1 \
  "${BASE_URL}/${ASSET}" \
  -o "$ASSET"

printf '%s  %s\n' "$EXPECTED_SHA256" "$ASSET" | sha256sum -c -

mkdir -p "$TMP_DIR/extract"
unzip -q "$ASSET" -d "$TMP_DIR/extract"
SOURCE="$TMP_DIR/extract/bun-linux-aarch64-android/bun"
[ -f "$SOURCE" ] || fail "expected Bun executable was not found in release archive"

chmod 755 "$SOURCE"

# Execute before installation so an incompatible Android runtime fails closed.
DETECTED_VERSION="$($SOURCE --version 2>/dev/null || true)"
[ -n "$DETECTED_VERSION" ] || fail "downloaded Bun Android binary could not execute on this device"
[ "$DETECTED_VERSION" = "$BUN_VERSION" ] || fail "downloaded Bun reported version '$DETECTED_VERSION', expected '$BUN_VERSION'"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
cp "$SOURCE" "$DEST"
chmod 755 "$DEST"
ln -sfn "$DEST" "$LAUNCHER"

printf '\nInstalled Bun runtime: %s\n' "$DEST"
printf 'Gateway launcher    : %s\n' "$LAUNCHER"
"$LAUNCHER" --version

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nPATH note: add this to your shell profile if needed:\n'
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\nRun the gateway from the repository with:\n'
printf '  cd gateway\n'
printf '  export GATEWAY_API_TOKEN="replace-with-a-long-random-secret"\n'
printf '  %s run src/server.ts\n' "$LAUNCHER"
